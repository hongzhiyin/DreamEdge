import { Type, type TSchema } from 'typebox';

export function gitToolDefinitions(commit: boolean, restore: boolean): { name: string; label: string; description: string; parameters: TSchema }[] {
  const paths = Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 20 });
  const tools = [
    { name: 'git_status', label: '查看 Git 状态', description: 'Inspect branch, current changes, HEAD and cached remote counts in the current business repository. Read-only; private paths are filtered.', parameters: Type.Object({}, { additionalProperties: false }) },
    { name: 'git_log', label: '查看 Git 历史', description: 'Read recent commits, full IDs, timestamps and parent IDs in the current repository. Use the full commit ID for diff/restore.', parameters: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 50 }) }, { additionalProperties: false }) },
    { name: 'git_diff', label: '查看 Git 差异', description: 'Read a bounded text diff. commitId=null compares working files to HEAD; a full commit ID shows that commit. paths=[] selects up to 20 ordinary changed files, otherwise use project-root file paths. Private/ignored paths excluded.', parameters: Type.Object({ commitId: Type.Union([Type.String({ pattern: '^[a-f0-9]{40,64}$' }), Type.Null()]), paths }, { additionalProperties: false }) },
  ];
  if (commit) tools.push({ name: 'git_commit', label: '提交 Git', description: 'User explicitly requested a local Git commit. Queue a concise message; native code checks the reviewed repository state and commits after successful build/apply. No remote push. Finish with propose_changes.', parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }) });
  if (restore) tools.push({ name: 'git_restore', label: '恢复 Git 内容', description: 'User explicitly requested restore. Choose a full reachable commit ID from git_log and project-relative file paths; [] restores ordinary text project files and renderer dependencies. Native code stages, compiles and applies, checkpoints current modifications before overwriting. Never resets HEAD or touches credentials/data. Finish this round with propose_changes files: [] and no extra edits.', parameters: Type.Object({ commitId: Type.String({ pattern: '^[a-f0-9]{40,64}$' }), paths }, { additionalProperties: false }) });
  return tools;
}
