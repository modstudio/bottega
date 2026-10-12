import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown/markdown'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { Textarea } from '@/ui/field/textarea'
import { Select } from '@/ui/listbox/select'
import { Sheet } from '@/ui/sheet/sheet'
import { DOC_SCOPES, type DocScope, isScope } from './docs'

type DocSearch = { edit?: boolean; id?: string; revision?: string | number }

export const Route = createFileRoute('/docs/$scope/$subject/$slug')({
  validateSearch: (search: Record<string, unknown>): DocSearch => ({
    edit: search.edit === true || search.edit === '1' || search.edit === 'true' ? true : undefined,
    id: typeof search.id === 'string' ? search.id : undefined,
    revision:
      typeof search.revision === 'string' || typeof search.revision === 'number'
        ? search.revision
        : undefined,
  }),
  component: DocRoute,
})

function DocRoute() {
  const { edit } = Route.useSearch()
  if (isHostedMode()) return null
  if (!edit) return null
  return <DocPage />
}

function subjectFromParam(param: string): string | null {
  return param === '_' ? null : param
}

function DocPage() {
  const navigate = useNavigate()
  const { scope, subject: subjectParam, slug } = Route.useParams()
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
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [delivery, setDelivery] = useState<'inject' | 'demand'>('inject')
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
    remove.mutate({
      scope,
      subject,
      slug,
      reason,
      expectedRevision: doc.data?.revision ?? undefined,
    })
  }

  function closeSheet() {
    void navigate({
      to: '/docs/$scope/$subject/$slug',
      params: { scope, subject: subjectParam, slug },
      search: {},
      replace: true,
    })
  }

  if (!scoped) {
    return (
      <Sheet open onClose={() => void navigate({ to: '/docs' })} title={slug}>
        <p data-tone="error" className="text-status-text">
          unknown scope"{scope}"; valid: {DOC_SCOPES.join(', ')}
        </p>
      </Sheet>
    )
  }

  return (
    <Sheet
      open
      size="document"
      onClose={closeSheet}
      title={<Input value={title} onChange={(e) => setTitle(e.target.value)} size="title" />}
      subtitle={`${scope} \u00b7 ${subject ?? slug}`}
      actions={
        <div className="flex shrink-0 gap-2">
          <Input
            aria-label="Reason"
            placeholder="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-52"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              save.mutate({
                scope,
                subject,
                slug,
                title,
                body,
                delivery,
                reason,
                expectedRevision: doc.data?.revision ?? undefined,
              })
            }
            disabled={save.isPending || !title || !reason.trim()}
          >
            <Save size={14} />
            Save
          </Button>
          <Button size="sm" variant="secondary" onClick={cancelEdit}>
            <X size={14} />
            Cancel
          </Button>
          <Button
            className="ml-2"
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
      {doc.isPending ? <p className="text-text-muted">Loading doc...</p> : null}
      {doc.error ? (
        <p data-tone="error" className="text-status-text">
          {doc.error.message}
        </p>
      ) : null}
      {save.error ? (
        <p data-tone="error" className="text-status-text">
          {save.error.message}
        </p>
      ) : null}
      {remove.error ? (
        <p data-tone="error" className="text-status-text">
          {remove.error.message}
        </p>
      ) : null}

      {doc.data ? (
        <div>
          <div className="mb-3 grid max-w-xs gap-1 text-sm">
            <span className="text-text-muted">Delivery</span>
            <Select
              label="Delivery"
              value={delivery}
              options={[
                { value: 'inject', label: 'Inject' },
                { value: 'demand', label: 'Demand' },
              ]}
              onChange={(next) => setDelivery(next as 'inject' | 'demand')}
            />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border border border-border-default">
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
    </Sheet>
  )
}
