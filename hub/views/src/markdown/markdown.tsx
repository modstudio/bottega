import { Callout } from '@bottega/hub-ui/callout'
import {
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import { secondLevelHeadings } from './headings.ts'
import { markdownStyles } from './markdown.styles.ts'
import { githubAlertPlugin, isTone } from './markdown-alerts'
import { fenceUse } from './markdown-fences'
import { DocOverflow } from './markdown-overflow'

const HIGHLIGHT_OPTIONS: { detect: boolean; plainText: string[] } = {
  detect: false,
  plainText: ['mermaid'],
}

export const MarkdownFenceRenderers = createContext<{
  fences?: Record<string, () => ReactNode>
}>({})

/**
 * A reading table. By default it takes its content's width and scrolls when that is wider than
 * the column; with `fit` it takes the column's width and wraps its cells instead.
 */
export function DocTable({ fit = false, children }: { fit?: boolean; children?: ReactNode }) {
  return (
    <DocOverflow expandLabel="Expand table" title="Table">
      <table data-fit={fit ? '' : undefined}>{children}</table>
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
  const renderers = useContext(MarkdownFenceRenderers)
  const child = Array.isArray(children) ? children[0] : children
  const language = nodeLanguage(child)?.toLowerCase()
  const custom = language ? renderers.fences?.[language] : undefined
  const use = fenceUse(language)
  useEffect(() => {
    if (use === 'highlight') onHighlightNeeded()
  }, [use, onHighlightNeeded])
  if (use === 'diagram' && isValidElement(child)) {
    return <MermaidSlot source={nodeText((child.props as { children?: ReactNode }).children)} />
  }
  if (custom) return custom()
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
  'data-doc-section-audiences'?: unknown
}) {
  const title = props['data-callout']
  const tone = props['data-tone']
  const sectionAudiences = props['data-doc-section-audiences']
  if (typeof sectionAudiences === 'string') {
    const labels = sectionAudiences
      .split(',')
      .map((audience) => audience.trim())
      .filter(Boolean)
      .map((audience) => audience[0]!.toLocaleUpperCase() + audience.slice(1))
    return (
      <div {...props}>
        <span className={markdownStyles().audience()}>{labels.join(', ')}</span>
        {children}
      </div>
    )
  }
  if (typeof title === 'string' && isTone(tone)) {
    return (
      <Callout tone={tone} title={title}>
        {children}
      </Callout>
    )
  }
  return <div {...props}>{children}</div>
}

function docSectionDirective() {
  return (tree: { children?: unknown[] }) => {
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const item = node as {
        type?: string
        name?: string
        attributes?: Record<string, string | null>
        children?: unknown[]
        data?: Record<string, unknown>
      }
      if (item.type === 'containerDirective' && item.name === 'section') {
        const audiences =
          typeof item.attributes?.audience === 'string'
            ? item.attributes.audience
                .split(',')
                .map((audience) => audience.trim())
                .filter(Boolean)
            : []
        item.data = {
          ...item.data,
          hName: 'div',
          hProperties: { 'data-doc-section-audiences': audiences.join(',') },
        }
      }
      for (const child of item.children ?? []) visit(child)
    }
    visit(tree)
  }
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
    <div className={markdownStyles().root()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, docSectionDirective]}
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
          table: DocTable,
          pre: Pre,
          div: DocCallout,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
