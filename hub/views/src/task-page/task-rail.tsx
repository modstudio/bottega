import { ArrowLeft, FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { ContentsList } from '../contents-list/contents-list.tsx'
import { DetailRail } from '../detail-rail/detail-rail.tsx'
import { secondLevelHeadings } from '../markdown/headings.ts'
import { taskRailStyles } from './task-rail.styles.ts'

export type TaskPageFact = { label: string; value: ReactNode }

export type TaskPageDoc = {
  id: string
  label: string
  title: string
  role: string | null
  body: string
  facts: TaskPageFact[]
  keyLine: { key: string; icon?: ReactNode; content: ReactNode }[]
}

function Facts({ facts, extra }: { facts: TaskPageFact[]; extra?: ReactNode }) {
  return (
    <>
      <dl className={taskRailStyles().facts()}>
        {facts.map((fact) => (
          <div key={fact.label} className={taskRailStyles().fact()}>
            <dt className={taskRailStyles().factLabel()}>{fact.label}</dt>
            <dd className={taskRailStyles().factValue()}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {extra ? <div className={taskRailStyles().extra()}>{extra}</div> : null}
    </>
  )
}

function headingItems(body: string) {
  return secondLevelHeadings(body).map((heading) => ({
    id: heading.id,
    href: `#${heading.id}`,
    label: heading.title.replace(/[`*]/g, ''),
  }))
}

function DocumentList({
  docs,
  current,
  onOpenDoc,
}: {
  docs: TaskPageDoc[]
  current?: string
  onOpenDoc: (id: string) => void
}) {
  return (
    <ContentsList
      label="Documents"
      items={docs.map((doc) => ({
        id: doc.id,
        current: doc.id === current,
        onSelect: () => onOpenDoc(doc.id),
        label: (
          <span className={taskRailStyles().doc()} title={doc.title}>
            <FileText size={13} className={taskRailStyles().docIcon()} />
            <span className={taskRailStyles().docTitle()}>{doc.title}</span>
          </span>
        ),
      }))}
    />
  )
}

/** The open page's sections, then every task document, with the open one marked. */
function TaskContents({
  body,
  docs,
  current,
  onOpenDoc,
}: {
  body: string
  docs: TaskPageDoc[]
  current?: string
  onOpenDoc: (id: string) => void
}) {
  const headings = headingItems(body)
  return (
    <div className={taskRailStyles().contents()}>
      <ContentsList items={headings} />
      <DocumentList docs={docs} current={current} onOpenDoc={onOpenDoc} />
      {!docs.length && !headings.length ? (
        <p className={taskRailStyles().nothing()}>Nothing to list yet.</p>
      ) : null}
    </div>
  )
}

/** Contents and Details beside the task; an open document takes the rail over until Back. */
export function TaskRail({
  doc,
  body,
  docs,
  details,
  detailsExtra,
  onOpenDoc,
}: {
  doc: TaskPageDoc | null
  body: string
  docs: TaskPageDoc[]
  details: TaskPageFact[]
  detailsExtra?: ReactNode
  onOpenDoc: (id: string | null) => void
}) {
  return (
    <div className={taskRailStyles().rail()}>
      <DetailRail
        key={doc ? `doc:${doc.id}` : 'task'}
        label={doc ? 'Document' : 'Task'}
        defaultTab="contents"
        top={
          doc ? (
            <button
              type="button"
              className={taskRailStyles().back()}
              onClick={() => onOpenDoc(null)}
            >
              <ArrowLeft size={14} />
              Back to task
            </button>
          ) : undefined
        }
        tabs={[
          {
            value: 'contents',
            label: 'Contents',
            content: (
              <TaskContents
                body={doc ? doc.body : body}
                docs={docs}
                current={doc?.id}
                onOpenDoc={onOpenDoc}
              />
            ),
          },
          {
            value: 'details',
            label: 'Details',
            content: doc ? (
              <Facts facts={doc.facts} />
            ) : (
              <Facts facts={details} extra={detailsExtra} />
            ),
          },
        ]}
      />
    </div>
  )
}

/** Below the rail's breakpoint the rail is hidden, so its facts and documents sit in the page. */
export function NarrowFacts({
  doc,
  docs,
  details,
  detailsExtra,
  onOpenDoc,
}: {
  doc: TaskPageDoc | null
  docs: TaskPageDoc[]
  details: TaskPageFact[]
  detailsExtra?: ReactNode
  onOpenDoc: (id: string | null) => void
}) {
  return (
    <div className={taskRailStyles().narrow()}>
      {doc ? (
        <>
          <button type="button" className={taskRailStyles().back()} onClick={() => onOpenDoc(null)}>
            <ArrowLeft size={14} />
            Back to task
          </button>
          <Facts facts={doc.facts} />
        </>
      ) : (
        <>
          <Facts facts={details} extra={detailsExtra} />
          <DocumentList docs={docs} onOpenDoc={onOpenDoc} />
        </>
      )}
    </div>
  )
}
