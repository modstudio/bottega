import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Pencil, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HostedDocDetail } from '@/components/hosted-doc-detail'
import { Markdown } from '@/components/markdown'
import { Sheet } from '@/components/sheet'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { DOC_SCOPES, type DocScope, isScope } from './docs'

type DocSearch = { edit?: boolean; id?: string }

export const Route = createFileRoute('/docs/$scope/$subject/$slug')({
  validateSearch: (search: Record<string, unknown>): DocSearch => ({
    edit: search.edit === true || search.edit === '1' || search.edit === 'true' ? true : undefined,
    id: typeof search.id === 'string' ? search.id : undefined,
  }),
  component: DocRoute,
})

function DocRoute() {
  const { slug } = Route.useParams()
  const { id } = Route.useSearch()
  return isHostedMode() ? <HostedDocDetail id={id} slug={slug} /> : <DocPage />
}

function subjectFromParam(param: string): string | null {
  return param === '_' ? null : param
}

function DocPage() {
  const navigate = useNavigate()
  const { scope, subject: subjectParam, slug } = Route.useParams()
  const { edit } = Route.useSearch()
  const subject = subjectFromParam(subjectParam)
  const scoped = isScope(scope)

  const doc = useQuery({
    ...trpc.doc.get.queryOptions({
      scope: (scoped ? scope : 'global') as DocScope,
      subject,
      slug,
    }),
    enabled: scoped,
  })
  const history = useQuery({
    ...trpc.doc.history.queryOptions({
      scope: (scoped ? scope : 'global') as DocScope,
      subject,
      slug,
    }),
    enabled: scoped,
  })

  const [editing, setEditing] = useState(Boolean(edit))
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [delivery, setDelivery] = useState<'inject' | 'demand'>('inject')
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    if (edit) setEditing(true)
  }, [edit])

  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title)
      setBody(doc.data.body)
      setDelivery(doc.data.delivery)
    }
  }, [doc.data])

  const save = useMutation({
    ...trpc.doc.set.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      setEditing(false)
      setReason('')
      setConfirmingDelete(false)
      await navigate({
        to: '/docs/$scope/$subject/$slug',
        params: { scope, subject: subjectParam, slug },
        search: {},
        replace: true,
      })
    },
  })

  const remove = useMutation({
    ...trpc.doc.remove.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await navigate({ to: '/docs' })
    },
  })

  function cancelEdit() {
    if (doc.data) {
      setTitle(doc.data.title)
      setBody(doc.data.body)
      setDelivery(doc.data.delivery)
    }
    setEditing(false)
    setReason('')
    setConfirmingDelete(false)
    void navigate({
      to: '/docs/$scope/$subject/$slug',
      params: { scope, subject: subjectParam, slug },
      search: {},
      replace: true,
    })
  }

  function onDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    if (!scoped) return
    if (!reason.trim()) return
    remove.mutate({ scope, subject, slug, reason })
  }

  if (!scoped) {
    return (
      <Sheet open onClose={() => void navigate({ to: '/docs' })} title={slug}>
        <p className="text-destructive">
          unknown scope "{scope}"; valid: {DOC_SCOPES.join(', ')}
        </p>
      </Sheet>
    )
  }

  return (
    <Sheet
      open
      onClose={() => void navigate({ to: '/docs' })}
      title={
        editing ? (
          <Input value={title} onChange={(e) => setTitle(e.target.value)} size="title" />
        ) : (
          (doc.data?.title ?? slug)
        )
      }
      subtitle={`${scope} \u00b7 ${subject ?? slug}`}
      actions={
        <div className="flex shrink-0 gap-2">
          {editing || confirmingDelete ? (
            <Input
              aria-label="Reason"
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-52"
            />
          ) : null}
          {editing ? (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => save.mutate({ scope, subject, slug, title, body, delivery, reason })}
                disabled={save.isPending || !title || !reason.trim()}
              >
                <Save size={14} />
                Save
              </Button>
              <Button size="sm" variant="secondary" onClick={cancelEdit}>
                <X size={14} />
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConfirmingDelete(false)
                setReason('')
                setEditing(true)
              }}
              disabled={!doc.data}
            >
              <Pencil size={14} />
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={onDelete}
            disabled={remove.isPending || !doc.data || (confirmingDelete && !reason.trim())}
          >
            <Trash2 size={14} />
            {confirmingDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        </div>
      }
    >
      {doc.isPending ? <p className="text-muted-foreground">Loading doc...</p> : null}
      {doc.error ? <p className="text-destructive">{doc.error.message}</p> : null}
      {save.error ? <p className="text-destructive">{save.error.message}</p> : null}
      {remove.error ? <p className="text-destructive">{remove.error.message}</p> : null}

      {doc.data && editing ? (
        <div>
          <label className="mb-3 block max-w-xs text-sm">
            <span className="text-muted-foreground">Delivery</span>
            <select
              className="flex h-10 w-full border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value as 'inject' | 'demand')}
            >
              <option value="inject">inject</option>
              <option value="demand">demand</option>
            </select>
          </label>
          <div className="grid grid-cols-2 divide-x divide-border border border-border">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              code
              bare
              className="min-h-[60vh]"
            />
            <div className="min-h-[60vh] overflow-auto p-3">
              <Markdown content={body} />
            </div>
          </div>
        </div>
      ) : null}

      {doc.data && !editing ? (
        <div className="prose-copy">
          <Markdown content={doc.data.body} />
        </div>
      ) : null}
      {doc.data && !editing ? (
        <div className="mt-8 border-t border-border pt-4">
          <h2 className="mb-3 text-sm font-semibold">History</h2>
          {history.error ? <p className="text-destructive">{history.error.message}</p> : null}
          {history.data?.map((revision) => (
            <div
              key={revision.id}
              className="grid grid-cols-[5rem_6rem_1fr_auto] gap-3 border-b border-border py-2 text-xs"
            >
              <span>
                #{revision.id} {revision.op}
              </span>
              <span>{revision.author}</span>
              <span>{revision.reason}</span>
              <span className="text-muted-foreground">
                {revision.at} · {revision.bytes} bytes
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Sheet>
  )
}
