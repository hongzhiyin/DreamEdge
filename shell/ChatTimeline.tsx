import { Check, Circle, CircleX, Clock3 } from 'lucide-react';
import type { DevelopmentEvent, DevelopmentTurn } from '../shared/contracts';
import './timeline.css';
import { MarkdownMessage } from './MarkdownMessage';

const labels = { list_files: '查看目录', read_file: '读取文件', search_files: '搜索源码', resolve_dependency: '查询依赖', set_dependencies: '声明依赖' };
const statuses = { running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止' };
function elapsed(event: DevelopmentEvent) {
  if (!event.startedAt || !event.finishedAt) return '';
  const seconds = (Date.parse(event.finishedAt) - Date.parse(event.startedAt)) / 1000;
  return seconds < 1 ? '<1 秒' : `${Math.round(seconds)} 秒`;
}
export function ChatTimeline({ turn }: { turn: DevelopmentTurn }) {
  const events: DevelopmentEvent[] = turn.events?.length ? turn.events : (turn.activity ?? []).map(event => ({
    ...event, kind: 'tool', label: labels[event.tool],
  }));
  if (!events.length) return null;
  const complete = turn.status === 'completed' && !!turn.summary;
  return <details className="chat-process" open={!complete}>
    <summary className="chat-process-summary">执行过程 · {events.length} 项<span>{complete ? '已完成' : statuses[turn.status === 'running' ? 'running' : turn.status === 'cancelled' ? 'cancelled' : 'failed']}</span></summary>
    <ol className="chat-timeline" aria-label="执行过程">
    {events.map(event => {
      const Icon = event.status === 'completed' ? Check : event.status === 'failed' ? CircleX : event.status === 'running' ? Clock3 : Circle;
      const title = `${event.label}${event.detail ? ` · ${event.detail}` : ''}`;
      const details = !!(event.content || event.input || event.output);
      const heading = <><Icon className="timeline-icon" size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="timeline-label">{title}</span><span className="timeline-status">{statuses[event.status]}</span>
        <span className="timeline-duration">{elapsed(event)}</span></>;
      return <li key={event.id} className={`timeline-event is-${event.status}`} data-event-kind={event.kind}>
        {details ? <details><summary aria-label={`${title} · ${statuses[event.status]}`}>{heading}</summary>
          <div className="timeline-content">
            {event.content && <MarkdownMessage content={event.content} />}
            {event.input && <><h4>调用参数</h4><pre>{event.input}</pre></>}
            {event.output && <><h4>{event.kind === 'tool' ? '返回结果' : '执行日志'}</h4><pre>{event.output}</pre></>}
          </div>
        </details> : <div className="timeline-heading" aria-label={`${title} · ${statuses[event.status]}`}>{heading}</div>}
      </li>;
    })}
    </ol>
  </details>;
}
