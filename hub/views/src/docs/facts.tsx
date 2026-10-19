import { relativeTime } from '@bottega/hub-util/format'
import { ContentsList } from '../contents-list/contents-list.tsx'
import { DetailRail } from '../detail-rail/detail-rail.tsx'
import type { DocHeading } from '../markdown/headings.ts'
import { RailSection as FactsSection } from '../rail-section/rail-section.tsx'
import { DocActions } from './doc-actions.tsx'
import { EditableAbout, type FieldSave, type SubjectCatalog } from './doc-field-controls.tsx'
import { factsStyles } from './facts.styles.ts'
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
        <p data-tone="error" className={factsStyles().summaryError()}>
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
            className={factsStyles().revision()}
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
    <dl className={factsStyles().facts()}>
      {doc.kind === 'article' ? (
        <>
          <dt className={factsStyles().summaryLabel()}>Summary</dt>
          <dd className={factsStyles().summary({ derived: doc.summarySource === 'derived' })}>
            {doc.summary || 'None'}
            {doc.summarySource === 'derived' ? (
              <span className={factsStyles().summarySource()}>From the opening paragraph</span>
            ) : null}
          </dd>
        </>
      ) : null}
      <dt className={factsStyles().audienceLabel()}>Audience</dt>
      <dd className={factsStyles().audienceValue()}>
        {doc.audiences.map((audience) => DOC_AUDIENCE_LABELS[audience]).join(', ')}
      </dd>
      {signedIn && doc.form ? (
        <>
          <dt className={factsStyles().typeLabel()}>Type</dt>
          <dd className={factsStyles().typeValue()}>{DOC_FORM_LABELS[doc.form]}</dd>
        </>
      ) : null}
      {signedIn && doc.articleSubject ? (
        <>
          <dt className={factsStyles().subjectLabel()}>Subject</dt>
          <dd className={factsStyles().subjectValue()}>{doc.articleSubject.name}</dd>
        </>
      ) : null}
      {signedIn && doc.relatedSubjects?.length ? (
        <>
          <dt className={factsStyles().relatedLabel()}>Related</dt>
          <dd className={factsStyles().relatedValue()}>
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
