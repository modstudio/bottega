import { useQuery } from '@tanstack/react-query'
import { ChevronDown, History } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { trpc } from '@/trpc/client'
import { Tabs } from '@/ui/tabs/tabs'
import { classes } from '@/ui/text/classes'
import type { DocScope } from '../../../../shared/docs.ts'
import { DOC_AUDIENCE_LABELS, DOC_FORM_LABELS } from './filters.ts'
import type { DocHeading } from './headings.ts'
import type { DocsDoc, DocsSource } from './types.ts'
import { useHeldPanel } from './use-held-panel.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'
type FactsTab = 'contents' | 'details'

export function revisionRelativeTime(value: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(value).getTime())
  if (elapsed < 90_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`
  return `${Math.round(elapsed / 86_400_000)}d ago`
}

function exactTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function Contents({ headings }: { headings: readonly DocHeading[] }) {
  if (!headings.length) return null
  return (
    <section>
      <span className={eyebrow}>On this page</span>
      <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a href={`#${heading.id}`} className="text-md text-text-muted hover:text-text-primary">
              {heading.title.replace(/[`*]/g, '')}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DocHistory({ doc }: { doc: DocsDoc }) {
  const [open, setOpen] = useState(false)
  const history = useQuery(
    trpc.doc.history.queryOptions({
      scope: doc.scope as DocScope,
      subject: doc.subject,
      slug: doc.slug,
    }),
  )
  const revisions = [...(history.data ?? [])].sort(
    (left, right) =>
      new Date(right.at).getTime() - new Date(left.at).getTime() || right.id - left.id,
  )
  return (
    <section className="mt-7 border-border-default border-t pt-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 py-1 text-md text-text-secondary hover:text-text-primary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <History size={14} />
        <span>History</span>
        <span className="ml-auto tabular-nums text-text-muted">
          {history.isPending ? '…' : revisions.length}
        </span>
        <ChevronDown
          size={14}
          className={classes(
            'transition-transform duration-(--duration-fast)',
            open && 'rotate-180',
          )}
        />
      </button>
      {history.error ? (
        <p data-tone="error" className="mt-2 text-sm text-status-text">
          {history.error.message}
        </p>
      ) : null}
      {open ? (
        <div className="mt-1">
          {revisions.map((revision) => (
            <div
              key={revision.id}
              title={`${exactTime(revision.at)} — ${revision.reason}`}
              className="border-border-default border-t py-2 text-sm text-text-muted"
            >
              {revisionRelativeTime(revision.at)} · {revision.author}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function Details({
  doc,
  signedIn,
  showHistory,
}: {
  doc: DocsDoc | null
  signedIn: boolean
  showHistory: boolean
}) {
  if (!doc) return null
  return (
    <>
      <section>
        <span className={eyebrow}>About</span>
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md">
          <dt className="text-text-muted">Audience</dt>
          <dd className="m-0 text-text-secondary">
            {doc.audiences.map((audience) => DOC_AUDIENCE_LABELS[audience]).join(', ')}
          </dd>
          {signedIn && doc.form ? (
            <>
              <dt className="text-text-muted">Type</dt>
              <dd className="m-0 text-text-secondary">{DOC_FORM_LABELS[doc.form]}</dd>
            </>
          ) : null}
          {signedIn && doc.articleSubject ? (
            <>
              <dt className="text-text-muted">Subject</dt>
              <dd className="m-0 text-text-secondary">{doc.articleSubject.name}</dd>
            </>
          ) : null}
          {signedIn && doc.relatedSubjects?.length ? (
            <>
              <dt className="text-text-muted">Related</dt>
              <dd className="m-0 text-text-secondary">
                {doc.relatedSubjects.map((subject) => subject.name).join(', ')}
              </dd>
            </>
          ) : null}
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
      {showHistory ? <DocHistory key={doc.id} doc={doc} /> : null}
    </>
  )
}

export function DocsFacts({
  doc,
  headings,
  signedIn,
  source,
}: {
  doc: DocsDoc | null
  headings: readonly DocHeading[]
  signedIn: boolean
  source: DocsSource
}) {
  const panel = useRef<HTMLElement>(null)
  useHeldPanel(panel)
  const [tab, setTab] = useState<FactsTab>(headings.length ? 'contents' : 'details')
  useEffect(() => {
    if (!headings.length) setTab('details')
  }, [headings.length])
  return (
    <aside
      ref={panel}
      className="hidden px-5 pb-8 lg:sticky lg:top-(--docs-stick) lg:block lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:overflow-y-auto"
    >
      <div className="sticky top-0 z-10 bg-surface-page pt-4">
        <Tabs
          label="Article information"
          value={tab}
          onChange={(value) => setTab(value as FactsTab)}
          items={[
            { value: 'contents', label: 'Contents' },
            { value: 'details', label: 'Details' },
          ]}
        />
      </div>
      <div role="tabpanel" className="pt-5">
        {tab === 'contents' ? (
          <Contents headings={headings} />
        ) : (
          <Details doc={doc} signedIn={signedIn} showHistory={signedIn && source === 'local'} />
        )}
      </div>
    </aside>
  )
}
