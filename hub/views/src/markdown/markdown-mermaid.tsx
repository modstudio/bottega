import DOMPurify from 'dompurify'
import { useEffect, useRef, useState } from 'react'
import { markdownMermaidStyles } from './markdown-mermaid.styles.ts'
import { DocOverflow } from './markdown-overflow'

type DrawState =
  | { kind: 'pending' }
  | { kind: 'drawn'; svg: string }
  | { kind: 'failed'; reason: string }

const MERMAID_SECURE_EXTRA = ['htmlLabels', 'themeCSS', 'fontFamily', 'altFontFamily']

const SVG_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'img', 'image'],
  FORBID_ATTR: ['style'],
}

let purifyHooked = false

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
        <p data-tone="error" className={markdownMermaidStyles().error()}>
          {status.reason}
        </p>
      ) : null}
    </div>
  )
}

/** A drawing this much wider than its column is scaled to fit; a wider one keeps its size and scrolls. */
const FIT_LIMIT = 1.35

function MermaidDrawing({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const drawing = parsed.documentElement
    if (!(drawing instanceof SVGSVGElement)) return
    node.replaceChildren(drawing)
    spaceBoxDescriptions(drawing)
    cornerGroupLabels(drawing)
    const natural = drawing.viewBox.baseVal
    if (!natural.width || !natural.height) return
    // Paint containment clips the host, so a drawing left wider than the column must widen the host for the column to scroll.
    const column = node.parentElement ?? node
    const fit = () => {
      const frame = diagramFrameWidth(node)
      const available = column.clientWidth - frame
      const width = fittedDiagramWidth(natural.width, available)
      drawing.setAttribute('width', String(width))
      drawing.setAttribute('height', String((natural.height * width) / natural.width))
      node.style.minWidth = width > available ? `${width + frame}px` : ''
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(column)
    return () => observer.disconnect()
  }, [svg])
  return <div className={markdownMermaidStyles().drawing()} ref={ref} />
}

/** The gap between a box's name and the description lines under it. */
const NAME_GAP = 4

/**
 * A box's first line is its name. Its line positions are in ems, which would follow
 * each line's own smaller size, so they are fixed in pixels at the drawing's text size
 * and the description is moved down by the gap, keeping the block centered.
 */
function spaceBoxDescriptions(drawing: SVGSVGElement) {
  const size = Number.parseFloat(cssToken('--docs-diagram-text')) || 14
  const pixels = (value: string | null) =>
    value?.endsWith('em') ? Number.parseFloat(value) * size : Number.parseFloat(value ?? '0') || 0
  for (const text of drawing.querySelectorAll('.node text')) {
    const lines = [...text.querySelectorAll(':scope > .text-outer-tspan')]
    if (lines.length < 2) continue
    lines.forEach((line, index) => {
      const shift = index === 0 ? -NAME_GAP / 2 : NAME_GAP / 2
      line.setAttribute('y', String(pixels(line.getAttribute('y'))))
      line.setAttribute('dy', String(pixels(line.getAttribute('dy')) + shift))
    })
  }
}

/** How far a group's title sits in from its top-left corner, on both sides. */
const GROUP_LABEL_INSET = 12
/** The backing behind a group's title, so a connector crossing it does not strike through the words. */
const GROUP_LABEL_BACKING = 4

/** A group's title sits in its top-left corner on a backing of the group's own color. */
function cornerGroupLabels(drawing: SVGSVGElement) {
  for (const group of drawing.querySelectorAll('.cluster')) {
    const box = group.querySelector('rect')
    const label = group.querySelector<SVGGElement>('.cluster-label')
    if (!box || !label) continue
    const words = label.getBBox()
    const left = Number.parseFloat(box.getAttribute('x') ?? '') + GROUP_LABEL_INSET
    const top = Number.parseFloat(box.getAttribute('y') ?? '') + GROUP_LABEL_INSET
    if (!Number.isFinite(left) || !Number.isFinite(top) || !words.width) continue
    label.setAttribute('transform', `translate(${left - words.x}, ${top - words.y})`)
    const backing = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    backing.setAttribute('class', 'doc-mermaid-group-backing')
    backing.setAttribute('x', String(words.x - GROUP_LABEL_BACKING))
    backing.setAttribute('y', String(words.y - GROUP_LABEL_BACKING))
    backing.setAttribute('width', String(words.width + 2 * GROUP_LABEL_BACKING))
    backing.setAttribute('height', String(words.height + 2 * GROUP_LABEL_BACKING))
    label.prepend(backing)
  }
}

/** The host's own padding and border, which the drawing does not get to use. */
function diagramFrameWidth(node: HTMLElement): number {
  const style = getComputedStyle(node)
  return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
    (sum, key) => sum + (Number.parseFloat(style.getPropertyValue(kebab(key))) || 0),
    0,
  )
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function fittedDiagramWidth(natural: number, available: number): number {
  if (available <= 0 || natural <= available) return natural
  return natural <= available * FIT_LIMIT ? available : natural
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
  const defaultSecure = mermaid.mermaidAPI.defaultConfig.secure ?? []
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    secure: [...defaultSecure, ...MERMAID_SECURE_EXTRA],
    theme: 'base',
    darkMode: dark,
    fontFamily: cssToken('--family-sans'),
    themeVariables: { ...mermaidTokens(), fontSize: cssToken('--docs-diagram-text') },
    flowchart: {
      useMaxWidth: false,
      wrappingWidth: 240,
      padding: 14,
      nodeSpacing: 28,
      rankSpacing: 44,
      curve: 'linear',
    },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
  })
  await mermaid.parse(source)
  const id = `docmmd${mermaidSeq++}`
  const { svg } = await mermaid.render(id, source)
  return sanitizeMermaidSvg(svg)
}

/** Strip diagram markup that could restyle the page or load a foreign resource. */
function sanitizeMermaidSvg(svg: string): string {
  if (!purifyHooked) {
    DOMPurify.addHook('afterSanitizeAttributes', forbidExternalUse)
    purifyHooked = true
  }
  return DOMPurify.sanitize(svg, SVG_PURIFY)
}

function forbidExternalUse(node: Element) {
  if (node.nodeName.toLowerCase() !== 'use') return
  const href =
    node.getAttribute('href') ??
    node.getAttribute('xlink:href') ??
    node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
    ''
  if (href !== '' && !href.startsWith('#')) node.remove()
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
  const sunken = cssColor('--surface-sunken')
  const text = cssColor('--text-primary')
  const secondary = cssColor('--text-secondary')
  const border = cssColor('--border-default')
  const strong = cssColor('--border-strong')
  return {
    background: sunken,
    primaryColor: page,
    primaryTextColor: text,
    primaryBorderColor: strong,
    lineColor: secondary,
    secondaryColor: sunken,
    tertiaryColor: page,
    mainBkg: page,
    nodeBorder: strong,
    titleColor: text,
    edgeLabelBackground: sunken,
    nodeTextColor: text,
    textColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
  }
}
