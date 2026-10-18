import type { McpControlView } from '../src/mcp/control-types.js';
export type McpServerView = McpControlView['servers'][number];
const states = { connecting: '连接中', discovering: '读取工具中', ready: '已连接', 'auth-required': '需要登录或凭据', disconnected: '连接中断', blocked: '配置已失效', failed: '连接失败', closed: '已断开' };
export function McpServerCard({ server, disabled, act }: { server: McpServerView; disabled: boolean;
  act(type: string, fields?: Record<string, unknown>): Promise<boolean> }) {
  const { config, identity, connection } = server;
  const status = server.revoked ? '已停用' : !config.enabled ? '已停用' : connection ? states[connection.state] : '就绪，调用时连接';
  const action = (type: string, extra: Record<string, unknown> = {}) => { void act(type, { identity, ...extra }); };
  return <article className="mcp-server">
    <header><h3>{config.displayName}</h3><span role="status">{status}</span></header>
    <div className="mcp-actions">
      <button disabled={disabled || !config.enabled} onClick={() => action('use')}>{connection?.state === 'ready' ? '用于当前对话' : '连接'}</button>
      <button disabled={!connection || connection.state === 'closed'} onClick={() => action('disconnect')}>断开</button>
    </div>
    {connection?.error && <p className="scope-error">{connection.error.message}</p>}
    <details><summary>详情</summary>
      {connection?.catalog && <><p>{connection.catalog.tools.length} 个工具 · {connection.catalog.resources.length} 个资源</p>
        <ul>{connection.catalog.tools.map(tool => <li key={tool.definition.name}>{tool.definition.name} · {tool.availability === 'compatible' ? '可调用' : tool.availability === 'denied' ? '已停用' : '暂不兼容'}</li>)}</ul></>}
      <div className="mcp-actions"><button disabled={disabled || connection?.state !== 'ready'} onClick={() => action('refresh')}>刷新工具</button>
        <button disabled={disabled} onClick={() => action('enable', { enabled: !config.enabled })}>{config.enabled ? '停用' : '启用'}</button>
        <button disabled={server.revoked} onClick={() => action('revoke')}>撤销连接授权</button></div>
    </details>
  </article>;
}
