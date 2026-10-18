import { useState } from 'react';
import type { ToolResult } from '../src/tools/types.js';

function OutputText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false); const clipped = text.length > 20_000 && !expanded;
  return <div><pre>{clipped ? text.slice(0, 20_000) : text}</pre>{text.length > 20_000 && <>
    {clipped && <p className="file-result-notice">界面仅显示前 20,000 个字符；工具实际返回内容未修改。</p>}
    <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起完整结果' : '展开完整结果'}</button>
  </>}</div>;
}
export function ToolOutput({ result }: { result: ToolResult }) {
  return <div className="tool-output">{result.content.map((block, index) => block.type === 'text'
    ? <OutputText key={index} text={block.text || '空文本结果。'} />
    : /^(image\/(png|jpeg|gif|webp))$/.test(block.mimeType)
      ? <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="工具返回的图片" loading="lazy" />
      : <p key={index}>图片结果：{block.mimeType}（此格式不预览）</p>)}</div>;
}
