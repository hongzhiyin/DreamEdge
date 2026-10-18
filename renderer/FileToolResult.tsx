import type { ChatToolCall } from '../src/chat/types.js';
import { fileResultView } from '../src/chat/file-result.js';
import { ToolOutput } from './ToolOutput.js';

const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
export function FileToolResult({ call }: { call: ChatToolCall }) {
  const file = fileResultView(call); if (!file) return null;
  return <div className="file-result" aria-label="文件操作结果">
    <p className="file-result-path">路径：{file.path}</p>
    {file.destination && <p className="file-result-meta">模型服务：{file.destination}</p>}
    {file.window && <p className="file-result-meta">{file.window}</p>}
    {file.bytes !== undefined && <p className="file-result-meta">{call.effect === 'write' ? '变更大小' : call.name === 'read' ? '读取输入' : '扫描输入'}：{bytesLabel(file.bytes)}
      {file.entries ? ` · 检查 ${file.entries} 项` : ''}
      {file.skipped ? ` · 已排除 ${file.skipped} 项` : ''}</p>}
    {file.notices.map(notice => <p key={notice} className="file-result-notice">{notice}</p>)}
    {file.mutation && <p className="file-result-meta">{file.mutation}</p>}
    {call.result && <details open><summary>{call.effect === 'write' ? '变更回执' : '工具返回内容'}</summary><ToolOutput result={call.result} /></details>}
  </div>;
}
