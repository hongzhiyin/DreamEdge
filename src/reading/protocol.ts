import type { JsonObject } from '@earendil-works/pi-ai';
import type { FileDestination } from '../files/scope-types.js';
export type ReaderReply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export interface ReaderInput { requestId: string; sessionId?: string; bookId?: string; contextVersion?: string; params: JsonObject }
export interface ReaderClient { call(operation: string, input: ReaderInput, signal: AbortSignal): Promise<ReaderReply> }
export interface ReaderSession { sessionId: string; bookId: string; title: string; page: number; contextVersion: string; ready: boolean }
export interface ReaderBinding { readerSessionId: string; bookId: string; title: string; destination: FileDestination; selectedNotes: string[] }
export interface ReaderRequest {
  requestId: string; chatId: string; bookId: string; operation: string; input: ReaderInput;
  status: 'pending' | 'complete' | 'uncertain'; result?: ReaderReply;
}
export const readerVersion = 'reader-bridge/v1';
export const failure = (code: string, message: string): ReaderReply => ({ ok: false, error: { code, message } });
