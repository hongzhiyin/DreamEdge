import type { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from '../conversation/types.js';
import type { RunMessageRecord } from '../runtime/tool-contracts.js';
import type { ToolCallRecord, ApprovalRecord } from '../tools/types.js';
import { canonicalJson } from '../tools/json.js';
import { assertToolTransition } from '../tools/state.js';
import { hasRunData } from '../conversation/run-data.js';
import { invalidToolData } from './tool-validation.js';

export function runMetadata(run: RunRecord): string {
  const { transcript: _messages, toolCalls: _calls, approvals: _approvals, ...metadata } = run;
  return JSON.stringify(metadata);
}

export function loadToolRows(db: DatabaseSync, runs: Map<string, RunRecord>): void {
  for (const run of runs.values()) if (run.toolsSnapshot !== undefined) {
    if (run.transcript !== undefined || run.toolCalls !== undefined || run.approvals !== undefined) invalidToolData();
    run.transcript = []; run.toolCalls = []; run.approvals = [];
  }
  for (const row of db.prepare('SELECT * FROM run_messages ORDER BY ordinal').all()) {
    const run = runs.get(String(row.run_id));
    if (!run || !hasRunData(run) || typeof row.record !== 'string') invalidToolData();
    const entry = JSON.parse(row.record) as RunMessageRecord;
    if (entry.runId !== row.run_id || entry.sessionId !== row.session_id || entry.turnId !== row.turn_id
      || entry.messageId !== row.message_id || entry.ordinal !== row.ordinal || entry.ordinal !== run.transcript.length) invalidToolData();
    run.transcript = [...run.transcript, entry];
  }
  for (const row of db.prepare('SELECT * FROM tool_calls ORDER BY ordinal').all()) {
    const run = runs.get(String(row.run_id));
    if (!run || !hasRunData(run) || typeof row.record !== 'string' || typeof row.approvals !== 'string') invalidToolData();
    const call = JSON.parse(row.record) as ToolCallRecord;
    const approvals = JSON.parse(row.approvals) as ApprovalRecord[];
    if (call.runId !== row.run_id || call.sessionId !== row.session_id || call.turnId !== row.turn_id
      || call.toolCallId !== row.tool_call_id || call.status !== row.status || row.ordinal !== run.toolCalls.length
      || !Array.isArray(approvals) || approvals.some(approval => approval.toolCallId !== call.toolCallId)) invalidToolData();
    run.toolCalls = [...run.toolCalls, call]; run.approvals = [...run.approvals, ...approvals];
  }
}

export function writeToolRows(db: DatabaseSync, run: RunRecord): void {
  const oldMessages = db.prepare('SELECT * FROM run_messages WHERE run_id = ? ORDER BY ordinal').all(run.runId);
  const oldCalls = db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY ordinal').all(run.runId);
  if (!hasRunData(run)) { if (oldMessages.length || oldCalls.length) invalidToolData(); return; }
  if (oldMessages.length > run.transcript.length || oldCalls.length > run.toolCalls.length) invalidToolData();
  const messageInsert = db.prepare('INSERT OR IGNORE INTO run_messages VALUES (?, ?, ?, ?, ?, ?)');
  for (const entry of run.transcript) {
    const encoded = JSON.stringify(entry);
    const old = oldMessages[entry.ordinal];
    if (old && old.record !== encoded) invalidToolData();
    if (!old && !messageInsert.run(entry.messageId, run.runId, run.sessionId, entry.turnId, entry.ordinal, encoded).changes) invalidToolData();
  }
  const callInsert = db.prepare(`INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, tool_call_id) DO UPDATE SET status = excluded.status, record = excluded.record, approvals = excluded.approvals
    WHERE tool_calls.session_id = excluded.session_id AND tool_calls.turn_id = excluded.turn_id AND tool_calls.ordinal = excluded.ordinal`);
  for (const [ordinal, call] of run.toolCalls.entries()) {
    const old = oldCalls[ordinal];
    const approvals = run.approvals.filter(approval => approval.toolCallId === call.toolCallId);
    if (old) {
      const previous = JSON.parse(String(old.record)) as ToolCallRecord;
      if (previous.toolCallId !== call.toolCallId || previous.turnId !== call.turnId
        || previous.toolName !== call.toolName || previous.toolVersion !== call.toolVersion
        || previous.argsDigest !== call.argsDigest || canonicalJson(previous.args) !== canonicalJson(call.args)
        || previous.effect !== call.effect || previous.approval !== call.approval || previous.createdAt !== call.createdAt) invalidToolData();
      if (previous.preview && canonicalJson(previous.preview) !== canonicalJson(call.preview)) invalidToolData();
      if (previous.status !== call.status) {
        try { assertToolTransition(previous, call.status); } catch { invalidToolData(); }
      }
      else if (!['requested', 'awaiting_approval', 'authorized', 'running'].includes(call.status)
        && old.record !== JSON.stringify(call)) invalidToolData();
      const previousApprovals = JSON.parse(String(old.approvals)) as ApprovalRecord[];
      for (const grant of previousApprovals) {
        const next = approvals.find(approval => approval.approvalId === grant.approvalId);
        if (!next || (grant.status !== 'pending' && JSON.stringify(next) !== JSON.stringify(grant))) invalidToolData();
        const { status: _status, ...before } = grant;
        const { status: _nextStatus, ...after } = next;
        if (grant.status === 'pending') {
          const { decidedAt: _time, ...withoutDecision } = after as typeof after & { decidedAt?: number };
          if (canonicalJson(before) !== canonicalJson(withoutDecision)) invalidToolData();
        }
      }
    }
    if (!callInsert.run(run.runId, call.toolCallId, run.sessionId, call.turnId, ordinal, call.status,
      JSON.stringify(call), JSON.stringify(approvals)).changes) invalidToolData();
  }
}
