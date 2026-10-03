export interface GitIntent { commit: boolean; restore: boolean }
export function gitIntent(prompt: string, explicitCommit = false): GitIntent {
  const clauses = prompt.split(/[，。；;\n]/).map(value => value.trim());
  const prefix = '(?:(?:请|帮我|替我|麻烦|现在|然后|再|并|只|完成后|修改后|改完后|直接|一下|可以帮我|能帮我)\\s*)*';
  const detect = (verb: string, english: string) => clauses.some(clause => {
    if (/如何|怎么|为什么|是什么意思|是否|会不会|能不能|解释|说明|介绍|how to|what is|explain|^commit (?:history|log|message)\b/i.test(clause)) return false;
    if (/[?？吗]$/.test(clause) && !/^(?:请|能|可以)?(?:帮我|替我)|^(?:can|could|would) you/i.test(clause)) return false;
    if (new RegExp(`(?:不要|别|勿|不自动|先不|不必).{0,10}(?:${verb})`, 'i').test(clause)
      || new RegExp(`(?:do not|don't|without).{0,10}(?:${english})`, 'i').test(clause)) return false;
    return new RegExp(`^${prefix}(?:${verb})`, 'i').test(clause)
      || new RegExp(`(?:并|然后|完成后|改完后)\\s*(?:${verb})`, 'i').test(clause)
      || new RegExp(`^${prefix}(?:把|将).+(?:${verb})`, 'i').test(clause)
      || new RegExp(`^(?:please\\s+|(?:can|could|would) you\\s+(?:please\\s+)?)*(?:git\\s+)?(?:${english})\\b`, 'i').test(clause);
  });
  const vetoCommit = /(?:不要|别|勿|不自动|先不|不必).{0,10}提交|(?:do not|don't|without).{0,10}commit/i.test(prompt);
  return { commit: explicitCommit && !vetoCommit || detect('提交(?:当前|全部|所有|这些|本次|这轮|工程|修改|代码|到|一下|吧|$)', 'commit'),
    restore: detect('恢复|还原|回退', 'restore|rollback|revert') };
}
