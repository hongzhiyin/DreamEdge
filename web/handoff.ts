import { randomBytes } from 'node:crypto';
import type { WebSession } from './auth.js';
import { chatCommand } from '../src/chat/validation.js';
import type { ChatHub } from '../src/chat/hub.js';
import type { ChatBootstrap } from '../src/chat/types.js';

export interface ScopedSession extends WebSession { sessionId: string }
export class WebHandoffs {
  private readonly tickets = new Map<string, { sessionId: string; expiresAt: number }>();
  private readonly sessions = new Map<string, ScopedSession>();
  constructor(private readonly now = Date.now) {}
  issue(sessionId: string) {
    this.sweep();
    if (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url'), expiresAt = this.now() + 60_000;
    this.tickets.set(ticket, { sessionId, expiresAt }); return { ticket, expiresAt };
  }
  exchange(ticket: unknown): { token: string; sessionId: string } | undefined {
    if (typeof ticket !== 'string') return;
    const value = this.tickets.get(ticket); this.tickets.delete(ticket);
    if (!value || value.expiresAt <= this.now()) return;
    this.sweep(); if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { csrf: token, sessionId: value.sessionId, expiresAt: this.now() + 8 * 60 * 60_000, watched: new Map() });
    return { token, sessionId: value.sessionId };
  }
  get(token: unknown): ScopedSession | undefined {
    if (typeof token !== 'string') return;
    const value = this.sessions.get(token); return value && this.valid(value) ? value : undefined;
  }
  valid(session: WebSession): boolean { return session.expiresAt > this.now() && [...this.sessions.values()].includes(session as ScopedSession); }
  revoke(sessionId?: string) {
    for (const [key, value] of this.tickets) if (!sessionId || value.sessionId === sessionId) this.tickets.delete(key);
    for (const [key, value] of this.sessions) if (!sessionId || value.sessionId === sessionId) this.sessions.delete(key);
  }
  private sweep() {
    for (const [key, value] of this.tickets) if (value.expiresAt <= this.now()) this.tickets.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
  }
}
export function scopedChat(hub: Pick<ChatHub, 'execute'>, value: unknown, scope: ScopedSession) {
  const command = chatCommand(value);
  const denied = { ok: false as const, error: { code: 'SESSION_SCOPE', message: '此页面仅可访问当前应用会话。' } };
  if (command.type === 'create') return denied;
  if (command.type === 'initialize') {
    const reply = hub.execute(command); if (!reply.ok) return reply;
    const data = reply.data as ChatBootstrap;
    return { ok: true as const, data: { ...data, sessions: data.sessions.filter(s => s.sessionId === scope.sessionId) } };
  }
  const id = command.type === 'send' ? command.input.sessionId : command.type === 'approval' ? command.decision.sessionId
    : command.type === 'resumeBatch' ? command.reference.sessionId : 'sessionId' in command ? command.sessionId : undefined;
  return id === scope.sessionId ? hub.execute(command) : denied;
}
