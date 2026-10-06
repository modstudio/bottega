import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { classes } from '@/ui/text/classes'
import { readingBody } from './body.ts'
import type { DocHeading } from './headings.ts'
import type { BreadcrumbPart } from './tree.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function DocsReading({
  doc,
  crumbs,
  around,
  onSelect,
  localActions,
  error,
}: {
  doc: DocsDoc | null
  crumbs: readonly BreadcrumbPart[]
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
  localActions?: ReactNode
  error?: string | null
}) {
  return (
    <main className="min-w-0 bg-surface-page px-6 py-8 md:px-11 md:py-9">
      {error ? (
        <p data-tone="error" className="text-status-text">
          {error}
        </p>
      ) : null}
      {doc ? (
        <>
          {crumbs.length ? (
            <div className={classes(eyebrow, 'flex flex-wrap gap-2')}>
              {crumbs.map((crumb, index) => (
                <span key={crumb.key} className="contents">
                  {index > 0 ? <span>/</span> : null}
                  <span>{crumb.label}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="doc-title">{doc.title}</h1>
            {localActions}
          </div>
          <div className="mt-6">
            <Markdown content={readingBody(doc.body)} />
          </div>
          <div className="doc-measure mt-14 flex justify-between gap-4 border-border-default border-t pt-4 text-md text-text-muted">
            {around.previous ? (
              <button
                type="button"
                className="text-left hover:text-text-primary"
                onClick={() => onSelect(around.previous!)}
              >
                ← {around.previous.title}
              </button>
            ) : (
              <span />
            )}
            {around.next ? (
              <button
                type="button"
                className="text-right hover:text-text-primary"
                onClick={() => onSelect(around.next!)}
              >
                {around.next.title} →
              </button>
            ) : (
              <span />
            )}
          </div>
        </>
      ) : (
        <p className="text-md text-text-muted">Select a document.</p>
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
  return (
    <aside className="hidden border-border-default border-l px-5 py-8 lg:block">
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
                  {heading.title}
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
