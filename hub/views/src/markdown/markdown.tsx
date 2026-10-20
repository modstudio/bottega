import { Callout } from '@bottega/hub-ui/callout'
import {
  createContext,
  Fragment,
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
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { parse } from 'yaml'
import { secondLevelHeadingIdsByLine } from './headings.ts'
import { markdownStyles } from './markdown.styles.ts'
import { githubAlertPlugin, isTone } from './markdown-alerts'
import { docDirectives } from './markdown-directives.ts'
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

type FrontmatterNode = {
  type: string
  value?: string
  children?: []
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function frontmatterPropertiesPlugin() {
  return (tree: { children?: FrontmatterNode[] }) => {
    for (const node of tree.children ?? []) {
      if (node.type !== 'yaml' || typeof node.value !== 'string') continue
      const source = node.value
      node.type = 'paragraph'
      node.children = []
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { ...node.data?.hProperties, 'data-frontmatter': source },
      }
    }
  }
}

function isPropertyMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function FrontmatterValue({
  value,
  ancestors,
}: {
  value: unknown
  ancestors: ReadonlySet<object>
}) {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '(cycle)'
    const nextAncestors = new Set(ancestors).add(value)
    return (
      <span className={markdownStyles().frontmatterItems()}>
        {value.map((item, index) => (
          <span key={index}>
            <FrontmatterValue value={item} ancestors={nextAncestors} />
          </span>
        ))}
      </span>
    )
  }
  if (isPropertyMap(value)) {
    if (ancestors.has(value)) return '(cycle)'
    return <PropertyList properties={value} ancestors={new Set(ancestors).add(value)} nested />
  }
  return (
    <span className={markdownStyles().frontmatterValue()}>
      {value == null ? '' : String(value)}
    </span>
  )
}

function PropertyList({
  properties,
  ancestors,
  nested = false,
}: {
  properties: Record<string, unknown>
  ancestors: ReadonlySet<object>
  nested?: boolean
}) {
  return (
    <dl className={markdownStyles({ nested }).frontmatterList()}>
      {Object.entries(properties).map(([key, value]) => (
        <Fragment key={key}>
          <dt className={markdownStyles().frontmatterKey()}>{key}</dt>
          <dd className={markdownStyles().frontmatterDetail()}>
            <FrontmatterValue value={value} ancestors={ancestors} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

function FrontmatterProperties({ source }: { source: string }) {
  let properties: unknown
  try {
    properties = parse(source)
  } catch {
    return <UnreadableFrontmatter source={source} />
  }
  if (properties == null) return null
  if (!isPropertyMap(properties)) return <UnreadableFrontmatter source={source} />
  if (Object.keys(properties).length === 0) return null
  return (
    <div className={markdownStyles().frontmatter()}>
      <PropertyList properties={properties} ancestors={new Set([properties])} />
    </div>
  )
}

function UnreadableFrontmatter({ source }: { source: string }) {
  return (
    <div>
      <p className={markdownStyles().frontmatterError()}>Frontmatter could not be read.</p>
      <pre>
        <code>{`---\n${source}\n---`}</code>
      </pre>
    </div>
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
  'data-frontmatter'?: unknown
}) {
  const frontmatter = props['data-frontmatter']
  if (typeof frontmatter === 'string') return <FrontmatterProperties source={frontmatter} />
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
  const headingIds = secondLevelHeadingIdsByLine(content)
  const [highlightNeeded, setHighlightNeeded] = useState(false)
  const requestHighlight = useCallback(() => setHighlightNeeded(true), [])
  const highlight = useHighlight(highlightNeeded)
  const Pre = useMemo<NonNullable<Components['pre']>>(
    () => (props) => <DocPre {...props} onHighlightNeeded={requestHighlight} />,
    [requestHighlight],
  )
  return (
    <div className={markdownStyles().root()}>
      <ReactMarkdown
        remarkPlugins={[
          remarkFrontmatter,
          frontmatterPropertiesPlugin,
          remarkGfm,
          remarkDirective,
          docDirectives,
        ]}
        rehypePlugins={[
          githubAlertPlugin,
          ...(highlight
            ? [[highlight, HIGHLIGHT_OPTIONS] as [typeof highlight, typeof HIGHLIGHT_OPTIONS]]
            : []),
        ]}
        components={{
          h2: ({ node, children }) => (
            <h2 id={headingIds.get(node?.position?.start.line ?? 0)}>{children}</h2>
          ),
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
