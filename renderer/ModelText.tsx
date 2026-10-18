import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ModelText({ text, thinking }: { text: string; thinking: string }) {
  return <>
    {thinking && <details className="thinking"><summary>思考过程</summary><div>{thinking}</div></details>}
    {text && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}
      components={{ img: () => null, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
      {text}</Markdown></div>}
  </>;
}
