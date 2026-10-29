import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownText({ text }: { text: string }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></div>;
}
