import { Link } from '@tanstack/react-router'
import { Maximize2, Minimize2 } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown/markdown'
import { Button } from '@/ui/button/button'
import { classes } from '@/ui/text/classes'
import { paneTitle, readingBody } from './body.ts'
import type { DocHeading } from './headings.ts'
import type { DocsLocation } from './location.ts'
import { DocStatusBadge } from './status-badge.tsx'
import type { BreadcrumbPart } from './tree.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'
import { useHeldPanel } from './use-held-panel.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'
/** Characters past which a title is set at the smaller size. */
const LONG_TITLE = 40

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/** Room the sticky article header takes, so the title counts as gone once it is behind it. */
const READING_TOP_HEIGHT = 44

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
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < line + 200)
      },
      { rootMargin: `-${line + READING_TOP_HEIGHT}px 0px 0px 0px` },
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
  wide,
  onWide,
}: {
  crumbs: readonly BreadcrumbPart[]
  title: string
  titleGone: boolean
  wide: boolean
  onWide: (wide: boolean) => void
}) {
  return (
    <div
      className={classes(
        '-mx-6 md:-mx-11 z-10 flex lg:sticky lg:top-(--docs-stick) items-center justify-between gap-4 border-b bg-surface-page px-6 py-2.5 md:px-11',
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
            <span className="min-w-0 truncate font-sans text-md text-text-primary normal-case tracking-normal">
              {title}
            </span>
          </>
        ) : null}
      </div>
      {/* For an article of wide tables: the pane takes the room of the facts column too. */}
      <div className="hidden shrink-0 lg:block">
        <Button size="sm" variant="secondary" onClick={() => onWide(!wide)}>
          {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          {wide ? 'Reading width' : 'Wide'}
        </Button>
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
  if (doc.status === 'current') return null
  return (
    <div className="doc-measure mt-3 flex flex-wrap items-center gap-2 text-md text-text-muted">
      <DocStatusBadge status={doc.status} />
      {doc.status === 'superseded' && doc.replacementSlug ? (
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
  localActions,
  error,
  pending,
  wide,
  onWide,
}: {
  doc: DocsDoc | null
  wide: boolean
  onWide: (wide: boolean) => void
  /** A document is chosen and on its way, so the pane stays quiet rather than saying there is none. */
  pending: boolean
  crumbs: readonly BreadcrumbPart[]
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  localActions?: ReactNode
  error?: string | null
}) {
  const shown = doc ? paneTitle(doc.title, doc.body) : { title: '', lede: null }
  const heading = useRef<HTMLHeadingElement>(null)
  const titleGone = useScrolledPast(heading, doc?.id)
  return (
    <main
      className="min-w-0 border-border-default bg-surface-page px-6 pt-5 pb-8 md:px-11 md:pt-6 md:pb-9 lg:border-x [.site-docs-chrome_&]:border-b"
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
            wide={wide}
            onWide={onWide}
          />
          <h1
            ref={heading}
            className="doc-title"
            data-long={shown.title.length > LONG_TITLE ? '' : undefined}
          >
            {shown.title}
          </h1>
          <DocLifecycle doc={doc} replacement={replacement} locationFor={locationFor} />
          {shown.lede ? (
            <p className="doc-measure mt-3.5 text-lg text-text-muted">{shown.lede}</p>
          ) : null}
          {localActions ? <div className="mt-4">{localActions}</div> : null}
          <div className="mt-6">
            <Markdown content={readingBody(doc.body)} />
          </div>
          <ReadingAround around={around} onSelect={onSelect} />
        </>
      ) : pending ? null : (
        <p className="text-md text-text-muted">No document to show.</p>
      )}
    </main>
  )
}

export function DocsFacts({
  doc,
  headings,
  signedIn,
}: {
  doc: DocsDoc | null
  headings: readonly DocHeading[]
  signedIn: boolean
}) {
  const panel = useRef<HTMLElement>(null)
  useHeldPanel(panel)
  return (
    <aside
      ref={panel}
      className="hidden px-5 py-8 lg:sticky lg:top-(--docs-stick) lg:block lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:overflow-y-auto"
    >
      {headings.length ? (
        <section>
          <span className={eyebrow}>On this page</span>
          <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0">
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className="text-md text-text-muted hover:text-text-primary"
                >
                  {heading.title.replace(/[`*]/g, '')}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {doc ? (
        <section className={headings.length ? 'mt-7' : undefined}>
          <span className={eyebrow}>About</span>
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md">
            <dt className="text-text-muted">Audience</dt>
            <dd className="m-0 text-text-secondary">
              {doc.audience === 'user' ? 'User' : 'Technical'}
            </dd>
            <dt className="text-text-muted">Updated</dt>
            <dd className="m-0 text-text-secondary">{updatedLabel(doc.updatedAt)}</dd>
            {signedIn ? (
              <>
                <dt className="text-text-muted">Address</dt>
                <dd className="m-0 min-w-0 break-words text-text-secondary">
                  {doc.scope} / {doc.subject ?? '—'} / {doc.slug}
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
    </aside>
  )
}
