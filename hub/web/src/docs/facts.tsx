import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, History, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Tabs } from '@/ui/tabs/tabs'
import { classes } from '@/ui/text/classes'
import type { DocScope } from '../../../../shared/docs.ts'
import { isDocReasonReady } from './edit-state.ts'
import { DOC_AUDIENCE_LABELS, DOC_FORM_LABELS } from './filters.ts'
import type { DocHeading } from './headings.ts'
import { savedVersionAuthor } from './reading.tsx'
import { isScope } from './scope.ts'
import type { DocsAudience, DocsDoc, DocsSource } from './types.ts'
import { useStoredDocument } from './use-docs.ts'
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
  const [open, setOpen] = useState(false)
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
          {history.isPending ? '…' : history.isSuccess ? revisions.length : null}
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
            <button
              type="button"
              key={revision.id}
              title={`${exactTime(revision.at)} — ${revision.reason}`}
              aria-current={revisionId === String(revision.id) ? 'true' : undefined}
              onClick={() => onRevision(revision.id)}
              className="block w-full cursor-pointer border-border-default border-t py-2 text-left text-sm text-text-muted hover:text-text-primary aria-current:font-medium aria-current:text-text-primary"
            >
              {relativeTime(revision.at)} ·{' '}
              {savedVersionAuthor(revision.author, revision.authorName)}
            </button>
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
  source,
  audience,
  revisionId,
  onRevision,
}: {
  doc: DocsDoc | null
  signedIn: boolean
  showHistory: boolean
  source: DocsSource
  audience: DocsAudience | null
  revisionId?: string
  onRevision: (id: number | string) => void
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
        </dl>
      </section>
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

function DocManage({ doc, source }: { doc: DocsDoc; source: DocsSource }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const scoped = isScope(doc.scope)
  const storedDocument = useStoredDocument(doc, source, open)
  const expectedRevision = storedDocument?.revision
  const hostedRevisionMissing = source === 'hosted' && !expectedRevision

  async function removed() {
    await queryClient.invalidateQueries()
    await navigate({ to: '/docs' })
  }

  const localRemove = useMutation({
    ...trpc.doc.remove.mutationOptions(),
    onSuccess: removed,
  })
  const hostedRemove = useMutation({
    ...trpc.record.deleteDoc.mutationOptions(),
    onSuccess: removed,
  })
  const removeState = source === 'hosted' ? hostedRemove : localRemove
  const canSubmit = isDocReasonReady(reason) && !hostedRevisionMissing && !removeState.isPending

  function submit() {
    if (!canSubmit) return
    if (source === 'hosted') {
      if (!doc.spaceId || !expectedRevision) return
      hostedRemove.mutate({
        id: doc.id,
        spaceId: doc.spaceId,
        reason: reason.trim(),
        expectedRevision,
      })
      return
    }
    if (!scoped) return
    localRemove.mutate({
      scope: doc.scope as DocScope,
      subject: doc.subject,
      slug: doc.slug,
      reason: reason.trim(),
      expectedRevision: expectedRevision ?? undefined,
    })
  }

  return (
    <section className="mt-7 border-border-default border-t pt-3">
      <span className={eyebrow}>Manage</span>
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            setReason('')
            setOpen(true)
          }}
        >
          <Trash2 size={14} />
          Delete article
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete article?"
        description="This removes the article. Give a reason to continue."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={!canSubmit} onClick={submit}>
              Delete article
            </Button>
          </>
        }
      >
        <label htmlFor="doc-delete-reason" className="grid gap-1 text-sm">
          <span className="text-text-muted">Reason</span>
          <Input
            id="doc-delete-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {removeState.error ? (
          <p data-tone="error" className="mt-2 text-sm text-status-text">
            {removeState.error.message}
          </p>
        ) : null}
      </Dialog>
    </section>
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
            showHistory={signedIn && source !== 'public'}
            source={source}
            audience={audience}
            revisionId={revisionId}
            onRevision={onRevision}
          />
        )}
        {canManage && doc ? <DocManage doc={doc} source={source} /> : null}
      </div>
    </aside>
  )
}
