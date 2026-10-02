import { useEffect, useRef } from 'react';
import { ArrowUp, Check, Code2, Sparkles, X } from 'lucide-react';

export function AiPanel({ toolName, onClose }: { toolName: string; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return <aside className="ai-panel" aria-label="AI 助手">
    <div className="ai-heading"><div><Sparkles size={18} /><strong>工具助手</strong></div>
      <button ref={close} className="icon-button" onClick={onClose} aria-label="关闭 AI 面板"><X size={19} /></button>
    </div>
    <p className="ai-context">当前工具 <strong>{toolName}</strong></p>
    <div className="ai-intro"><span className="ai-symbol"><Code2 size={25} /></span>
      <h2>让工具随你生长</h2><p>以后，你可以在这里描述想法，<br />让 AI 帮你修改当前工具。</p>
    </div>
    <div className="phase-note"><span className="eyebrow">第一阶段 · 宿主与样例</span>
      <h3>基础能力已就位</h3>
      <p><Check size={15} />独立运行当前业务应用</p>
      <p><Check size={15} />独立保存本机业务数据</p>
      <p className="next-step">下一阶段将接入模型、代码修改与预览。当前面板尚不能发送消息或修改工具。</p>
    </div>
    <div className="ai-composer"><textarea aria-label="AI 需求输入" disabled placeholder="模型尚未接入" rows={3} />
      <div><small>第二阶段开放</small><button disabled aria-label="发送需求"><ArrowUp size={18} /></button></div>
    </div>
  </aside>;
}
