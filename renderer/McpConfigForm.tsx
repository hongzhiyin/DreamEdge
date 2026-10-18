import { useState } from 'react';
export function McpConfigForm({ text, disabled, save, cancel }: { text: string; disabled: boolean;
  save(text: string): Promise<boolean>; cancel(): void }) {
  const [value, setValue] = useState(text), [error, setError] = useState('');
  const example = '{\n  "mcpServers": {\n    "my-app": {\n      "command": "/path/to/app",\n      "args": ["mcp"]\n    }\n  }\n}';
  async function submit() {
    try { JSON.parse(value); setError(''); if (await save(value)) cancel(); }
    catch { setError('JSON 格式无效，请复制完整配置。'); }
  }
  return <form className="mcp-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <label>MCP 配置（JSON）<textarea aria-label="MCP 配置（JSON）" value={value} spellCheck={false}
      placeholder={example} onChange={e => setValue(e.target.value)} disabled={disabled} /></label>
    <label className="mcp-file">或选择 JSON 文件<input type="file" accept=".json,application/json" disabled={disabled} onChange={e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 256 * 1024) { setError('配置文件过大。'); return; }
      void file.text().then(setValue).catch(() => setError('无法读取配置文件。'));
    }} /></label>
    <div className="mcp-form-footer">
      {error && <p role="alert" className="scope-error">{error}</p>}
      <div className="mcp-actions"><button type="submit" disabled={disabled || !value.trim()}>保存并连接</button>
        <button type="button" disabled={disabled} onClick={cancel}>取消</button></div>
    </div>
    <p className="scope-help">使用应用提供的 mcpServers JSON。保存后即可在对话中调用，无需填写内部版本或逐项登记。</p>
  </form>;
}
