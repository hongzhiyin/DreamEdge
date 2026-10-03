import type { DevelopmentEvent, DevelopmentTurn } from '../../shared/contracts';

const kinds = ['model', 'thinking', 'message', 'tool', 'build', 'apply', 'commit'];
const statuses = ['running', 'completed', 'failed', 'cancelled'];
const fields = ['content', 'input', 'output'] as const;
const bytes = (event: DevelopmentEvent) => fields.reduce((total, field) => total + Buffer.byteLength(event[field] ?? ''), 0);
function bounded(value: string, limit: number) {
  const buffer = Buffer.from(value); if (buffer.length <= limit) return value;
  const suffix = '\n…（内容已截断）';
  return limit < Buffer.byteLength(suffix) ? '' : buffer.subarray(0, limit - Buffer.byteLength(suffix)).toString('utf8') + suffix;
}
export function recordEvent(turn: DevelopmentTurn, event: DevelopmentEvent): void {
  const events = turn.events ??= []; const previous = events.findIndex(item => item.id === event.id);
  if (previous < 0 && events.length >= 128) return;
  const value = { ...events[previous], ...event, startedAt: events[previous]?.startedAt ?? new Date().toISOString(),
    finishedAt: event.status === 'running' ? undefined : new Date().toISOString() };
  let remaining = Math.max(0, 128 * 1024 - events.reduce((total, item, index) => total + (index === previous ? 0 : bytes(item)), 0));
  for (const field of fields) if (value[field] !== undefined) {
    value[field] = bounded(value[field]!, Math.min(8192, remaining)); remaining -= Buffer.byteLength(value[field]!);
  }
  if (previous < 0) events.push(value); else events[previous] = value;
}
export function finishEvents(turn: DevelopmentTurn, status: 'failed' | 'cancelled') {
  for (const event of turn.events ?? []) if (event.status === 'running') { event.status = status; event.finishedAt = new Date().toISOString(); }
}
export function validateEvents(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128 || new Set(value.map(event => event?.id)).size !== value.length) throw new Error('执行记录无效。');
  let total = 0;
  for (const event of value) {
    if (!event || typeof event.id !== 'string' || event.id.length > 180 || !kinds.includes(event.kind) || !statuses.includes(event.status)
      || typeof event.label !== 'string' || event.label.length > 240 || typeof event.detail !== 'undefined' && (typeof event.detail !== 'string' || event.detail.length > 200)
      || [event.startedAt, event.finishedAt].some(time => time !== undefined && (typeof time !== 'string' || !Number.isFinite(Date.parse(time))))) throw new Error('执行记录无效。');
    for (const field of fields) if (event[field] !== undefined && (typeof event[field] !== 'string' || event[field].includes('\0') || Buffer.byteLength(event[field]) > 8200)) throw new Error('执行详情无效。');
    total += bytes(event);
  }
  if (total > 128 * 1024 + 512) throw new Error('执行详情超过记录上限。');
}
