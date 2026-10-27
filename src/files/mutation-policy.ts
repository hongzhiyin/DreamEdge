import { basename, sep } from 'node:path';
import type { MutationPlan } from './mutation-types.js';
import type { ToolInspection } from '../tools/execution-policy.js';

export type MutationPolicy = (plan: Readonly<MutationPlan>) => ToolInspection | Promise<ToolInspection>;
export const accountMutationVersion = 'pi-1.1.0/account-mutation-1';
const result = (decision: ToolInspection['decision'], rule: string, reason: string): ToolInspection =>
  ({ decision, rule: `file-operations/v1/${rule}`, reason });

export function sensitiveConfigurationPath(input: string): boolean {
  const path = input.normalize('NFC').toLowerCase().replaceAll('\\', '/'); const name = basename(path);
  return /^\/(?:etc|private\/etc|system|library|usr|bin|sbin)(?:\/|$)/.test(path)
    || /^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)/.test(path)
    || (process.platform === 'win32' && ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'].some(key => {
      const root = process.env[key]?.toLowerCase().replaceAll('\\', '/').replace(/\/$/, '');
      return !!root && (path === root || path.startsWith(`${root}/`));
    }))
    || /\/microsoft\/windows\/start menu\/programs\/startup(?:\/|$)/.test(path)
    || /\/(?:windowspowershell|powershell)\/(?:microsoft\.[^/]+_)?profile\.ps1$/.test(path)
    || /\/library\/(?:launchagents|launchdaemons)\//.test(path)
    || /\/(?:\.config\/systemd|\.config\/autostart)\//.test(path)
    || ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile'].includes(name);
}

/** Classifies the actual Pi-generated preview, not the model's explanation or tool hints. */
export const inspectFileMutation: MutationPolicy = plan => {
  const { preview: p } = plan;
  const name = basename(p.path).normalize('NFC').toLowerCase();
  const path = p.path.normalize('NFC').toLowerCase().split(sep).join('/');
  if (name === 'file-access.local.json' || path.split('/').some(part => ['.ssh', '.codex', '.aws', '.gnupg'].includes(part))) {
    return result('deny', 'protected-policy', '凭据及权限配置不能通过普通文件工具修改。');
  }
  if (sensitiveConfigurationPath(path)) {
    return result('ask', 'system-configuration', '此操作会修改系统、启动或命令行配置。');
  }
  if (p.operation === 'overwrite') return result('ask', 'overwrite', '此操作会整体覆盖已有文件。');
  if (p.operation === 'create') return result('allow', 'create', '新建普通文件，不覆盖已有内容。');
  if (p.operation !== 'edit') return result('deny', 'unknown-operation', '无法识别文件变更效果。');
  if (plan.original.length && !plan.content.trim()) return result('ask', 'clear', '此编辑会清空文件内容。');
  let removed = 0; let inHunk = false;
  for (const line of p.patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('-')) removed++;
  }
  const lines = Math.max(1, plan.original.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/).length);
  if (p.afterBytes < plan.original.length * 0.5 || removed >= 50 || (removed >= 5 && removed / lines >= 0.5)) {
    return result('ask', 'large-edit', '此编辑删除或替换了较多原有内容，请核对差异。');
  }
  return result('allow', 'local-edit', '普通局部编辑，提交前仍核对文件版本。');
};
