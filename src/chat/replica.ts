import type { ChatEvent } from './types.js';

/** Replay and snapshot responses may arrive after a newer live event. */
export function newerFrame(current: ChatEvent | undefined, next: ChatEvent, resetEpoch = false): boolean {
  if (!current) return true;
  if (current.sessionId !== next.sessionId) return false;
  if (current.epoch !== next.epoch) return resetEpoch;
  return next.sequence > current.sequence;
}
