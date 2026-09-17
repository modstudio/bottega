import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Markdown } from '@/components/markdown'
import { trpc } from '@/trpc/client'
import { Sheet } from '@/ui/sheet/sheet'

type HostedDoc = { body: string }
type HostedRevision = { id: string; op: string; author: string; reason: string; at: string }

export function HostedDocContent({
  doc,
  revisions,
}: {
  doc: HostedDoc
  revisions: HostedRevision[]
}) {
  return (
    <>
      <Markdown content={doc.body} />
      <div className="mt-8 border-t border-border-default pt-4">
        <h2 className="mb-3 text-sm font-semibold">History</h2>
        {revisions.map((revision) => (
          <div
            key={revision.id}
            className="grid grid-cols-[6rem_6rem_1fr_auto] gap-3 border-b border-border-default py-2 text-xs"
          >
            <span>{revision.op}</span>
            <span>{revision.author}</span>
            <span>{revision.reason}</span>
            <span className="text-text-muted">{revision.at}</span>
          </div>
        ))}
      </div>
    </>
  )
}

export function HostedDocDetail({ id, slug }: { id?: string; slug: string }) {
  const navigate = useNavigate()
  const queryId = id ?? '00000000-0000-4000-8000-000000000000'
  const doc = useQuery({ ...trpc.record.doc.queryOptions({ id: queryId }), enabled: Boolean(id) })
  const history = useQuery({
    ...trpc.record.docRevisions.queryOptions({ id: queryId }),
    enabled: Boolean(id),
  })
  return (
    <Sheet open onClose={() => void navigate({ to: '/docs' })} title={doc.data?.title ?? slug}>
      {!id ? (
        <p data-tone="error" className="text-status-text">
          Open this document from the Docs list.
        </p>
      ) : null}
      {doc.isPending && id ? <p className="text-text-muted">Loading doc...</p> : null}
      {doc.error ? (
        <p data-tone="error" className="text-status-text">
          {doc.error.message}
        </p>
      ) : null}
      {history.error ? (
        <p data-tone="error" className="text-status-text">
          {history.error.message}
        </p>
      ) : null}
      {doc.data ? <HostedDocContent doc={doc.data} revisions={history.data?.items ?? []} /> : null}
    </Sheet>
  )
}
