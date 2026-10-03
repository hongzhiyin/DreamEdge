import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

const plugins = [remarkGfm];

export function MarkdownMessage({ content, className = '' }: { content: string; className?: string }) {
  return <div className={`markdown-content ${className}`}>
    <Markdown remarkPlugins={plugins} skipHtml urlTransform={url => {
      const safe = defaultUrlTransform(url);
      return /^(https?:|mailto:|#)/i.test(safe) ? safe : '';
    }} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ alt }) => <span className="markdown-image">[图片{alt ? `：${alt}` : ''}]</span>,
      table: ({ children }) => <div className="markdown-table" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>,
    }}>{content}</Markdown>
  </div>;
}
