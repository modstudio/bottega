import { Tabs } from '@bottega/hub-ui/tabs'
import { classes } from '@bottega/hub-ui/text/classes'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { trpc } from '@/trpc/client'
import type { DocScope } from '../../../../shared/docs.ts'
import { DocActions } from './doc-actions.tsx'
import { EditableAbout } from './doc-field-controls.tsx'
import { DOC_AUDIENCE_LABELS, DOC_FORM_LABELS } from './filters.ts'
import type { DocHeading } from './headings.ts'
import { savedVersionAuthor } from './reading.tsx'
import type { DocsAudience, DocsDoc, DocsSource } from './types.ts'
import { useHeldPanel } from './use-held-panel.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'
type FactsTab = 'contents' | 'details'

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

/**
 * A collapsible group of the Details tab. Collapsed, its label sits between equal space above and
 * below; sections after the first are divided by a rule.
 */
function FactsSection({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string
  count?: ReactNode
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-border-default [&:not(:first-child)]:border-t">
      <button
        type="button"
        className={classes(
          eyebrow,
          'flex w-full cursor-pointer items-center gap-2 py-3 text-left hover:text-text-primary',
        )}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        {count !== undefined ? (
          <span className="ml-auto tabular-nums tracking-normal">{count}</span>
        ) : null}
        <ChevronDown
          size={14}
          className={classes(
            count === undefined && 'ml-auto',
            'transition-transform duration-(--duration-fast)',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? <div className="pb-4">{children}</div> : null}
    </section>
  )
}

function DocHistory({
  doc,
  source,
  audience,
  revisionId,
  onRevision,
}: {
  doc: DocsDoc
  source: DocsSource
  audience: DocsAudience | null
  revisionId?: string
  onRevision: (id: number | string) => void
}) {
  const localHistory = useQuery({
    ...trpc.doc.history.queryOptions({
      scope: doc.scope as DocScope,
      subject: doc.subject,
      slug: doc.slug,
    }),
    enabled: source === 'local',
  })
  const hostedHistory = useQuery({
    ...trpc.record.docRevisions.queryOptions({
      id: doc.id,
      audience: audience ?? undefined,
    }),
    enabled: source === 'hosted',
  })
  const history = source === 'hosted' ? hostedHistory : localHistory
  const revisions = [
    ...(source === 'hosted' ? (hostedHistory.data?.items ?? []) : (localHistory.data ?? [])),
  ].sort(
    (left, right) =>
      new Date(right.at).getTime() - new Date(left.at).getTime() ||
      String(right.id).localeCompare(String(left.id)),
  )
  return (
    <FactsSection
      label="History"
      defaultOpen={false}
      count={history.isPending ? '…' : history.isSuccess ? revisions.length : undefined}
    >
      {history.error ? (
        <p data-tone="error" className="mt-2 text-sm text-status-text">
          {history.error.message}
        </p>
      ) : null}
      <div>
        {revisions.map((revision) => (
          <button
            type="button"
            key={revision.id}
            title={`${exactTime(revision.at)} — ${revision.reason}`}
            aria-current={revisionId === String(revision.id) ? 'true' : undefined}
            onClick={() => onRevision(revision.id)}
            className="block w-full cursor-pointer border-border-default border-t py-2 text-left text-sm text-text-muted hover:text-text-primary aria-current:font-medium aria-current:text-text-primary"
          >
            {relativeTime(revision.at)} · {savedVersionAuthor(revision.author, revision.authorName)}
          </button>
        ))}
      </div>
    </FactsSection>
  )
}

function Details({
  doc,
  signedIn,
  canManage,
  showHistory,
  source,
  audience,
  revisionId,
  onRevision,
}: {
  doc: DocsDoc | null
  signedIn: boolean
  canManage: boolean
  showHistory: boolean
  source: DocsSource
  audience: DocsAudience | null
  revisionId?: string
  onRevision: (id: number | string) => void
}) {
  if (!doc) return null
  return (
    <>
      <FactsSection label="About" defaultOpen>
        {canManage ? (
          <EditableAbout key={doc.id} doc={doc} source={source} />
        ) : (
          <ReadonlyAbout doc={doc} signedIn={signedIn} />
        )}
      </FactsSection>
      {showHistory ? (
        <DocHistory
          key={doc.id}
          doc={doc}
          source={source}
          audience={audience}
          revisionId={revisionId}
          onRevision={onRevision}
        />
      ) : null}
    </>
  )
}

function ReadonlyAbout({ doc, signedIn }: { doc: DocsDoc; signedIn: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md">
      {doc.kind === 'article' ? (
        <>
          <dt className="text-text-muted">Summary</dt>
          <dd
            className={
              doc.summarySource === 'derived' ? 'm-0 text-text-muted' : 'm-0 text-text-secondary'
            }
          >
            {doc.summary || 'None'}
            {doc.summarySource === 'derived' ? (
              <span className="mt-1 block text-xs">From the opening paragraph</span>
            ) : null}
          </dd>
        </>
      ) : null}
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
    </dl>
  )
}

export function DocsFacts({
  doc,
  headings,
  signedIn,
  source,
  audience,
  revisionId,
  onRevision = () => {},
  canManage = false,
}: {
  doc: DocsDoc | null
  headings: readonly DocHeading[]
  signedIn: boolean
  source: DocsSource
  audience: DocsAudience | null
  revisionId?: string
  onRevision?: (id: number | string) => void
  canManage?: boolean
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
          <Details
            doc={doc}
            signedIn={signedIn}
            canManage={canManage && Boolean(doc)}
            showHistory={signedIn && source !== 'public'}
            source={source}
            audience={audience}
            revisionId={revisionId}
            onRevision={onRevision}
          />
        )}
        {canManage && doc && tab === 'details' ? (
          <FactsSection label="Actions" defaultOpen>
            <DocActions key={doc.id} doc={doc} source={source} />
          </FactsSection>
        ) : null}
      </div>
    </aside>
  )
}
