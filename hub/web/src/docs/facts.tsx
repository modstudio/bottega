import { relativeTime } from '@bottega/hub-util/format'
import { ContentsList } from '@bottega/hub-views/contents-list'
import { DetailRail } from '@bottega/hub-views/detail-rail'
import type { DocHeading } from '@bottega/hub-views/markdown/headings'
import { RailSection as FactsSection } from '@bottega/hub-views/rail-section'
import { DocActions } from './doc-actions.tsx'
import { EditableAbout, type FieldSave, type SubjectCatalog } from './doc-field-controls.tsx'
import { DOC_AUDIENCE_LABELS, DOC_FORM_LABELS } from './filters.ts'
import { savedVersionAuthor } from './reading.tsx'
import type { DocsDoc, DocsTreeItem } from './types.ts'

export type DocsFactsControls = {
  field: FieldSave
  items: readonly DocsTreeItem[]
  subjects: SubjectCatalog
  remove: {
    run: (reason: string) => Promise<unknown>
    pending: boolean
    error: unknown
    refused?: string
  }
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
  return (
    <ContentsList
      items={headings.map((heading) => ({
        id: heading.id,
        href: `#${heading.id}`,
        label: heading.title.replace(/[`*]/g, ''),
      }))}
    />
  )
}

function DocHistory({
  history,
  revisionId,
  onRevision,
}: {
  history: {
    items: readonly {
      id: number | string
      at: string
      reason: string
      author: string
      authorName?: string | null
    }[]
    pending: boolean
    error: unknown
  }
  revisionId?: string
  onRevision: (id: number | string) => void
}) {
  return (
    <FactsSection
      label="History"
      defaultOpen={false}
      count={history.pending ? '…' : history.error ? undefined : history.items.length}
    >
      {history.error ? (
        <p data-tone="error" className="mt-2 text-sm text-status-text">
          {history.error instanceof Error ? history.error.message : String(history.error)}
        </p>
      ) : null}
      <div>
        {history.items.map((revision) => (
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
  controls,
  history,
  revisionId,
  onRevision,
}: {
  doc: DocsDoc | null
  signedIn: boolean
  canManage: boolean
  showHistory: boolean
  controls?: DocsFactsControls
  history: Parameters<typeof DocHistory>[0]['history']
  revisionId?: string
  onRevision: (id: number | string) => void
}) {
  if (!doc) return null
  return (
    <>
      <FactsSection label="About" defaultOpen>
        {canManage ? (
          controls ? (
            <EditableAbout
              key={doc.id}
              doc={doc}
              field={controls.field}
              items={controls.items}
              subjects={controls.subjects}
            />
          ) : null
        ) : (
          <ReadonlyAbout doc={doc} signedIn={signedIn} />
        )}
      </FactsSection>
      {showHistory ? (
        <DocHistory
          key={doc.id}
          history={history}
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
  showHistory,
  controls,
  history,
  revisionId,
  onRevision = () => {},
  canManage = false,
}: {
  doc: DocsDoc | null
  headings: readonly DocHeading[]
  signedIn: boolean
  showHistory: boolean
  controls?: DocsFactsControls
  history: Parameters<typeof DocHistory>[0]['history']
  revisionId?: string
  onRevision?: (id: number | string) => void
  canManage?: boolean
}) {
  return (
    <DetailRail
      label="Article information"
      defaultTab={headings.length ? 'contents' : 'details'}
      tabs={[
        {
          value: 'contents',
          label: 'Contents',
          content: <Contents headings={headings} />,
          hidden: !headings.length,
        },
        {
          value: 'details',
          label: 'Details',
          content: (
            <>
              <Details
                doc={doc}
                signedIn={signedIn}
                canManage={canManage && Boolean(doc)}
                showHistory={signedIn && showHistory}
                controls={controls}
                history={history}
                revisionId={revisionId}
                onRevision={onRevision}
              />
              {canManage && controls && doc ? (
                <FactsSection label="Actions" defaultOpen>
                  <DocActions key={doc.id} remove={controls.remove} />
                </FactsSection>
              ) : null}
            </>
          ),
        },
      ]}
    />
  )
}
