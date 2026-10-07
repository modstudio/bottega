import { useEffect, useRef, useState } from 'react'
import { DocOverflow } from './markdown-overflow'

type DrawState =
  | { kind: 'pending' }
  | { kind: 'drawn'; svg: string }
  | { kind: 'failed'; reason: string }

/**
 * A mermaid fence: the source while the library loads, the drawing once it
 * succeeds, or the source plus the parser's reason when it fails.
 */
export function MermaidBlock({ source }: { source: string }) {
  const [status, setStatus] = useState<DrawState>({ kind: 'pending' })
  const dark = useDarkClass()
  useEffect(() => {
    let live = true
    setStatus({ kind: 'pending' })
    void drawMermaid(source, dark).then(
      (svg) => {
        if (live) setStatus({ kind: 'drawn', svg })
      },
      (error: unknown) => {
        if (live) setStatus({ kind: 'failed', reason: parseReason(error) })
      },
    )
    return () => {
      live = false
    }
  }, [source, dark])
  if (status.kind === 'drawn') {
    return (
      <DocOverflow expandLabel="Expand diagram" title="Diagram">
        <MermaidDrawing svg={status.svg} />
      </DocOverflow>
    )
  }
  return (
    <div>
      <pre>
        <code>{source}</code>
      </pre>
      {status.kind === 'failed' ? (
        <p data-tone="error" className="doc-mermaid-error">
          {status.reason}
        </p>
      ) : null}
    </div>
  )
}

function MermaidDrawing({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const drawing = parsed.documentElement
    if (drawing instanceof SVGSVGElement) node.replaceChildren(drawing)
  }, [svg])
  return <div className="doc-mermaid" ref={ref} />
}

function useDarkClass() {
  const [dark, setDark] = useState(readDark)
  useEffect(() => {
    const root = document.documentElement
    const update = () => setDark(root.classList.contains('dark'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function readDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function parseReason(error: unknown): string {
  if (error instanceof Error) {
    const line = error.message.split('\n')[0]?.trim()
    if (line) return line
  }
  return 'The diagram could not be drawn.'
}

let mermaidSeq = 0

async function drawMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
    fontFamily: cssToken('--family-mono'),
    themeVariables: mermaidTokens(),
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
  })
  await mermaid.parse(source)
  const id = `docmmd${mermaidSeq++}`
  const { svg } = await mermaid.render(id, source)
  return svg
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Mermaid rejects oklch; resolve the token through a canvas to sRGB. */
function cssColor(name: string): string {
  const value = cssToken(name)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return value
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const pixel = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`
}

function mermaidTokens() {
  const page = cssColor('--surface-page')
  const raised = cssColor('--surface-raised')
  const sunken = cssColor('--surface-sunken')
  const text = cssColor('--text-primary')
  const secondary = cssColor('--text-secondary')
  const border = cssColor('--border-default')
  return {
    background: page,
    primaryColor: raised,
    primaryTextColor: text,
    primaryBorderColor: border,
    lineColor: secondary,
    secondaryColor: sunken,
    tertiaryColor: raised,
    mainBkg: raised,
    nodeBorder: border,
    clusterBkg: sunken,
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: page,
    nodeTextColor: text,
    textColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
  }
}
