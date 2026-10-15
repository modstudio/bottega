import { Link } from '@tanstack/react-router'
import { CalendarDays, Maximize2, Minimize2 } from 'lucide-react'
import { type ReactNode, type Ref, type RefObject, useEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown/markdown'
import { Button } from '@/ui/button/button'
import { classes } from '@/ui/text/classes'
import { readingBody, viewedPaneTitle } from './body.ts'
import { CodeSection } from './code-section.tsx'
import { EditableSourceFiles, EditableStatus } from './doc-field-controls.tsx'
import { DOC_STATUS_LABELS } from './filters.ts'
import type { DocsLocation } from './location.ts'
import { DOC_STATUS_ICONS } from './status-icon.ts'
import type { BreadcrumbPart } from './tree.ts'
import type { DocsAudience, DocsDoc, DocsSource, DocsTreeItem } from './types.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'
/** Characters past which a title is set at the smaller size. */
export const LONG_TITLE = 40

export function savedVersionAuthor(author: string, authorName?: string | null): string {
  const name = authorName?.trim()
  if (name) return name
  const label = author.trim()
  return !label || label === 'unknown' ? 'System' : label
}

/** Whether this reading view is one that shows where an article lives in the code. */
function showsCode(signedIn: boolean, audience: DocsAudience | null): boolean {
  return signedIn && (audience === null || audience === 'technical')
}

/** Whether source paths belong in this reading view. */
export function showSourceFiles(
  signedIn: boolean,
  audience: DocsAudience | null,
  sourceFiles: readonly string[] | undefined,
): boolean {
  return showsCode(signedIn, audience) && Boolean(sourceFiles?.length)
}

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function StatusLine({ status }: { status: DocsDoc['status'] }) {
  const Icon = DOC_STATUS_ICONS[status]
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={14} />
      {DOC_STATUS_LABELS[status]}
    </span>
  )
}

/** Whether the element has scrolled up behind the article's sticky header. */
function useScrolledPast(target: RefObject<HTMLElement | null>, watch: unknown): boolean {
  const [past, setPast] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new document mounts a new title to watch.
  useEffect(() => {
    const node = target.current
    if (!node) {
      setPast(false)
      return
    }
    const sticky = node.previousElementSibling
    const line = sticky ? Number.parseFloat(getComputedStyle(sticky).top) || 0 : 0
    // The header's own height, so the title counts as gone once it is behind it.
    const header = sticky ? sticky.getBoundingClientRect().height : 0
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < line + 200)
      },
      { rootMargin: `-${line + header}px 0px 0px 0px` },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [target, watch])
  return past
}

/**
 * The article's own header: it stays at the top of the pane while the article scrolls, and
 * once the title has scrolled away it carries the title as the last crumb.
 */
function ReadingTop({
  crumbs,
  title,
  titleGone,
  headerAction,
  wide,
  onWide,
}: {
  crumbs: readonly BreadcrumbPart[]
  title: string
  titleGone: boolean
  headerAction?: ReactNode
  wide: boolean
  onWide: (wide: boolean) => void
}) {
  return (
    <div
      className={classes(
        '-mx-6 md:-mx-15 z-10 flex lg:sticky lg:top-(--docs-stick) items-center justify-between gap-4 border-b bg-surface-page px-6 py-2.5 md:px-15',
        titleGone ? 'border-border-default' : 'border-transparent',
      )}
    >
      <div
        className={classes(
          eyebrow,
          'flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap',
        )}
      >
        {crumbs.map((crumb, index) => (
          <span key={crumb.key} className="contents">
            {index > 0 ? <span>/</span> : null}
            <span>{crumb.label}</span>
          </span>
        ))}
        {titleGone ? (
          <>
            <span>/</span>
            <span className="min-w-0 truncate text-text-primary">{title}</span>
          </>
        ) : null}
      </div>
      {/* For an article of wide tables: the pane takes the room of the facts column too. */}
      <div className="flex shrink-0 items-center gap-2">
        {headerAction}
        <span className="hidden lg:inline-flex">
          <Button size="sm" variant="secondary" onClick={() => onWide(!wide)}>
            {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            {wide ? 'Reading width' : 'Wide'}
          </Button>
        </span>
      </div>
    </div>
  )
}

function ReadingAround({
  around,
  onSelect,
}: {
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
}) {
  const { previous, next } = around
  return (
    <div className="doc-measure -mb-8 md:-mb-9 mt-14 flex items-center justify-between gap-4 border-border-default border-t py-5 text-md text-text-muted">
      {previous ? (
        <button
          type="button"
          className="text-left hover:text-text-primary"
          onClick={() => onSelect(previous)}
        >
          ← {previous.title}
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button
          type="button"
          className="text-right hover:text-text-primary"
          onClick={() => onSelect(next)}
        >
          {next.title} →
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function DocLifecycle({
  doc,
  replacement,
  locationFor,
}: {
  doc: DocsDoc
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
}) {
  if (doc.status !== 'superseded' || !doc.replacementSlug) return null
  return (
    <span>
      Replaced by{' '}
      {replacement ? (
        <Link {...locationFor(replacement)} className="text-link hover:underline">
          {replacement.title}
        </Link>
      ) : (
        doc.replacementSlug
      )}
    </span>
  )
}

function ArticleHeading({
  shown,
  heading,
  titleView,
  editing,
  doc,
  signedIn,
  replacement,
  locationFor,
  fieldSource,
  editBand,
}: {
  shown: { title: string; lede: string | null }
  heading: RefObject<HTMLElement | null>
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  editing?: boolean
  doc: DocsDoc
  signedIn: boolean
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  fieldSource?: DocsSource
  editBand?: ReactNode
}) {
  return (
    <>
      {titleView ? (
        titleView(heading)
      ) : (
        <h1
          ref={heading as Ref<HTMLHeadingElement>}
          className="doc-title"
          data-long={shown.title.length > LONG_TITLE ? '' : undefined}
        >
          {shown.title}
        </h1>
      )}
      {editBand ?? (
        <DocKeyInfo
          doc={doc}
          signedIn={signedIn}
          replacement={replacement}
          locationFor={locationFor}
          statusView={
            fieldSource ? <EditableStatus key={doc.id} doc={doc} source={fieldSource} /> : undefined
          }
        />
      )}
      {shown.lede && !editing ? (
        <p className="doc-measure mt-3.5 text-lg text-text-muted">{shown.lede}</p>
      ) : null}
    </>
  )
}

function DocKeyInfo({
  doc,
  signedIn,
  replacement,
  locationFor,
  statusView,
}: {
  doc: DocsDoc
  signedIn: boolean
  statusView?: ReactNode
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
}) {
  return (
    <div className="doc-measure mt-3 flex min-h-control-sm flex-wrap items-center gap-x-4 gap-y-2 text-md text-text-muted">
      {signedIn ? (statusView ?? <StatusLine status={doc.status} />) : null}
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays size={14} />
        Updated {updatedLabel(doc.updatedAt)}
      </span>
      {signedIn ? (
        <DocLifecycle doc={doc} replacement={replacement} locationFor={locationFor} />
      ) : null}
    </div>
  )
}

export function DocsReading({
  doc,
  crumbs,
  around,
  onSelect,
  replacement,
  locationFor,
  headerAction,
  error,
  pending,
  wide,
  onWide,
  signedIn,
  audience,
  bodyView,
  viewedRevision,
  editing,
  editBand,
  banner,
  titleView,
  fieldSource,
}: {
  doc: DocsDoc | null
  wide: boolean
  onWide: (wide: boolean) => void
  signedIn: boolean
  audience: DocsAudience | null
  bodyView?: ReactNode
  viewedRevision?: { title: string; body: string } | null
  /** A document is chosen and on its way, so the pane stays quiet rather than saying there is none. */
  pending: boolean
  crumbs: readonly BreadcrumbPart[]
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  headerAction?: ReactNode
  error?: string | null
  editing?: boolean
  /** While editing, the tools that take the place of the status line under the title. */
  editBand?: ReactNode
  banner?: ReactNode
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  /** Where the article's fields are saved, set only when this reader may edit them in place. */
  fieldSource?: DocsSource
}) {
  const shown = doc ? viewedPaneTitle(doc, viewedRevision ?? null) : { title: '', lede: null }
  const heading = useRef<HTMLElement>(null)
  const titleGone = useScrolledPast(heading, `${doc?.id ?? ''}:${editing ? '1' : '0'}`)
  return (
    <main
      className="min-w-0 border-border-default bg-surface-page px-6 pt-5 pb-8 md:px-15 md:pt-6 md:pb-9 lg:border-x [.site-docs-chrome_&]:border-b"
      data-doc-wide={wide ? '' : undefined}
    >
      {error ? (
        <p data-tone="error" className="text-status-text">
          {error}
        </p>
      ) : null}
      {doc ? (
        <>
          <ReadingTop
            crumbs={crumbs}
            title={shown.title}
            titleGone={titleGone}
            headerAction={headerAction}
            wide={wide}
            onWide={onWide}
          />
          {banner}
          <ArticleHeading
            shown={shown}
            heading={heading}
            titleView={titleView}
            editing={editing}
            doc={doc}
            signedIn={signedIn}
            replacement={replacement}
            locationFor={locationFor}
            fieldSource={fieldSource}
            editBand={editBand}
          />
          {bodyView ?? (
            <div className="mt-6">
              <Markdown content={readingBody(doc.body)} />
            </div>
          )}
          {fieldSource && doc.kind === 'article' && showsCode(signedIn, audience) ? (
            <EditableSourceFiles key={doc.id} doc={doc} source={fieldSource} />
          ) : showSourceFiles(signedIn, audience, doc.sourceFiles) ? (
            <CodeSection key={doc.id} count={doc.sourceFiles?.length ?? 0}>
              <ul>
                {doc.sourceFiles?.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </CodeSection>
          ) : null}
          <ReadingAround around={around} onSelect={onSelect} />
        </>
      ) : pending ? null : (
        <p className="text-md text-text-muted">No document to show.</p>
      )}
    </main>
  )
}
