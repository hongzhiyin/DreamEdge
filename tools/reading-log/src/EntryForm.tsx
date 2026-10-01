import { useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { today, type EntryInput } from './model';

export function EntryForm({ disabled, busy, onAdd }: {
  disabled: boolean; busy: boolean; onAdd(input: EntryInput): Promise<boolean>;
}) {
  const [date, setDate] = useState(today);
  const [content, setContent] = useState('');
  const [minutes, setMinutes] = useState('30');
  const contentInput = useRef<HTMLTextAreaElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy) return;
    if (await onAdd({ date, content, minutes: Number(minutes) })) {
      setContent(''); contentInput.current?.focus();
    }
  }
  return <section className="entry-card" aria-labelledby="entry-title">
    <div className="section-heading"><h2 id="entry-title">记录一段阅读</h2><span>积累，从这一页开始</span></div>
    <form onSubmit={submit}>
      <fieldset disabled={disabled || busy}>
        <div className="form-row">
          <label>阅读日期<input type="date" required value={date} onChange={event => setDate(event.target.value)} /></label>
          <label>阅读时长<span className="minute-input"><input type="number" required min="1" max="1440" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} /><span>分钟</span></span></label>
        </div>
        <label className="content-label">阅读内容<textarea ref={contentInput} rows={3} required maxLength={2000} value={content} onChange={event => setContent(event.target.value)} placeholder="一本书、一篇文章，或一段让你停下来的文字…" /></label>
        <div className="form-bottom"><span>每一点专注，都值得被记录。</span><button className="primary-button" type="submit"><Plus size={17} />{busy ? '保存中…' : '保存记录'}</button></div>
      </fieldset>
    </form>
  </section>;
}
