import type { FileScopeOverview } from '../src/files/scope-types.js';

export function DeviceAccess({ device, disabled, busy, change }: {
  device: NonNullable<FileScopeOverview['device']>; disabled: boolean; busy: boolean; change(enabled: boolean): void;
}) {
  if (device.mode === 'account') return <div className="device-access" aria-label="文件访问模式">
    <p className="device-heading">账户权限访问</p>
    <p className="scope-help">使用启动账户的文件权限，无需选择目录。普通新建和局部编辑自动执行；覆盖、清空、大范围编辑及系统配置修改需在对话中确认。</p>
    <p className="scope-help">凭据等敏感文件仍排除，系统拒绝访问时不会自动提权。多文件变更可按批次确认；删除默认进入废纸篓，永久删除须单独核对。</p>
    {device.baseDirectory && <p className="scope-context">相对路径基于：{device.baseDirectory}</p>}
  </div>;
  return <div className="device-access" aria-label="文件访问模式">
    <p className="device-heading">{device.enabled ? '整机访问已开启' : '指定目录模式'}</p>
    <p className="scope-help">整机模式无需逐个选择目录，适用于当前模型服务的所有对话。普通读取、列表和搜索直接执行；每次新建、覆盖和编辑仍需预览确认。删除尚未开放。</p>
    <p className="scope-help">敏感文件排除和系统权限始终生效，文件内容按任务需要发送到上方模型服务。更改模式会停止正在运行的对话。</p>
    {device.baseDirectory && <p className="scope-context">相对路径基于：{device.baseDirectory}</p>}
    <button className={device.enabled ? 'scope-revoke' : 'scope-add'} disabled={disabled || busy}
      onClick={() => change(!device.enabled)}>{device.enabled ? '关闭整机访问' : '开启整机访问'}</button>
  </div>;
}
