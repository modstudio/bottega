import { isValidElement, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { secondLevelHeadings } from '@/docs/headings'
import { Callout } from '@/ui/callout/callout'
import { githubAlertPlugin, isTone } from './markdown-alerts'
import { fenceUse } from './markdown-fences'
import { DocOverflow } from './markdown-overflow'

const HIGHLIGHT_OPTIONS: { detect: boolean; plainText: string[] } = {
  detect: false,
  plainText: ['mermaid'],
}

function DocTable({ children }: { children: ReactNode }) {
  return (
    <DocOverflow expandLabel="Expand table" title="Table">
      <table>{children}</table>
    </DocOverflow>
  )
}

function nodeLanguage(node: unknown): string | undefined {
  if (!isValidElement(node)) return undefined
  const className = (node.props as { className?: unknown }).className
  if (typeof className !== 'string') return undefined
  const match = /(?:^|\s)language-([^\s]+)/.exec(className)
  return match?.[1]
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

function MermaidSlot({ source }: { source: string }) {
  const [Block, setBlock] = useState<null | ((props: { source: string }) => ReactNode)>(null)
  useEffect(() => {
    let live = true
    void import('./markdown-mermaid').then((mod) => {
      if (live) setBlock(() => mod.MermaidBlock)
    })
    return () => {
      live = false
    }
  }, [])
  if (!Block) {
    return (
      <pre>
        <code>{source}</code>
      </pre>
    )
  }
  return <Block source={source} />
}

function DocPre({
  children,
  node: _node,
  onHighlightNeeded,
  ...props
}: {
  children?: ReactNode
  node?: unknown
  onHighlightNeeded: () => void
}) {
  const child = Array.isArray(children) ? children[0] : children
  const use = fenceUse(nodeLanguage(child))
  useEffect(() => {
    if (use === 'highlight') onHighlightNeeded()
  }, [use, onHighlightNeeded])
  if (use === 'diagram' && isValidElement(child)) {
    return <MermaidSlot source={nodeText((child.props as { children?: ReactNode }).children)} />
  }
  return <pre {...props}>{children}</pre>
}

function DocCallout({
  children,
  node: _node,
  ...props
}: {
  children?: ReactNode
  node?: unknown
  'data-callout'?: unknown
  'data-tone'?: unknown
}) {
  const title = props['data-callout']
  const tone = props['data-tone']
  if (typeof title === 'string' && isTone(tone)) {
    return (
      <Callout tone={tone} title={title}>
        {children}
      </Callout>
    )
  }
  return <div {...props}>{children}</div>
}

function useHighlight(needed: boolean) {
  const [plugin, setPlugin] = useState<null | typeof import('rehype-highlight').default>(null)
  useEffect(() => {
    if (!needed) return
    let live = true
    void import('rehype-highlight').then((mod) => {
      if (live) setPlugin(() => mod.default)
    })
    return () => {
      live = false
    }
  }, [needed])
  return needed ? plugin : null
}

// Raw HTML in a doc is NOT rendered (react-markdown's default).
export function Markdown({ content }: { content: string }) {
  const headings = secondLevelHeadings(content)
  const [highlightNeeded, setHighlightNeeded] = useState(false)
  const requestHighlight = useCallback(() => setHighlightNeeded(true), [])
  const highlight = useHighlight(highlightNeeded)
  const Pre = useMemo<NonNullable<Components['pre']>>(
    () => (props) => <DocPre {...props} onHighlightNeeded={requestHighlight} />,
    [requestHighlight],
  )
  let heading = 0
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          githubAlertPlugin,
          ...(highlight
            ? [[highlight, HIGHLIGHT_OPTIONS] as [typeof highlight, typeof HIGHLIGHT_OPTIONS]]
            : []),
        ]}
        components={{
          h2: ({ children }) => {
            const id = headings[heading++]?.id
            return <h2 id={id}>{children}</h2>
          },
          table: ({ children }) => <DocTable>{children}</DocTable>,
          pre: Pre,
          div: DocCallout,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
