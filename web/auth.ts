import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface WebSession { csrf: string; expiresAt: number; watched: Map<string, string> }
const nonce = () => randomBytes(24).toString('base64url');
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
};
export class WebAuth {
  private pairing: { code: string; expiresAt: number; attempts: number } | undefined;
  private sessions = new Map<string, WebSession>();
  readonly cookieName = 'dreamedge_web_session';
  constructor(private readonly now = Date.now) {}
  issuePairingCode() {
    const code = randomBytes(9).toString('base64url');
    this.pairing = { code, expiresAt: this.now() + 5 * 60_000, attempts: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }
  pair(code: unknown): { cookie: string; csrf: string } | undefined {
    const pair = this.pairing;
    if (!pair || pair.expiresAt <= this.now() || pair.attempts >= 20) return;
    pair.attempts++;
    if (typeof code !== 'string' || !equal(pair.code, code)) return;
    this.pairing = undefined;
    for (const [key, value] of this.sessions) if (!this.valid(value)) this.sessions.delete(key);
    if (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value!);
    const key = nonce(), csrf = nonce(); this.sessions.set(key, { csrf, expiresAt: this.now() + 8 * 60 * 60_000, watched: new Map() });
    return { cookie: `${this.cookieName}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, csrf };
  }
  session(request: IncomingMessage): WebSession | undefined {
    const key = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1);
    const session = key ? this.sessions.get(key) : undefined;
    return session && this.valid(session) ? session : undefined;
  }
  valid(session: WebSession) { return session.expiresAt > this.now() && [...this.sessions.values()].includes(session); }
  csrf(request: IncomingMessage, session: WebSession) {
    const value = request.headers['x-dreamedge-csrf']; return typeof value === 'string' && equal(session.csrf, value);
  }
  revokeAll() { this.pairing = undefined; this.sessions.clear(); }
}

export function sameOrigin(request: IncomingMessage, origin: string, write: boolean) {
  if (request.headers.host !== new URL(origin).host) return false;
  const from = request.headers.origin;
  if (from !== undefined && from !== origin) return false;
  if (write && from !== origin) return false;
  const site = request.headers['sec-fetch-site'];
  return site !== 'cross-site' && site !== 'same-site';
}
