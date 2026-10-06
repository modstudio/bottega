import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { secondLevelHeadings } from '@/docs/headings'

// Raw HTML in a doc is NOT rendered (react-markdown's default).
export function Markdown({ content }: { content: string }) {
  const headings = secondLevelHeadings(content)
  let heading = 0
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => {
            const id = headings[heading++]?.id
            return <h2 id={id}>{children}</h2>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
