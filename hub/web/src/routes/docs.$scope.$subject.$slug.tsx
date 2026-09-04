import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Pencil, Save, Trash2, X } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/button'
import { Input } from '@/components/input'
import { Textarea } from '@/components/textarea'
import { queryClient, trpc } from '@/trpc/client'
import { PageHeader } from '@/components/design-system'
import { DOC_SCOPES, isScope, type DocScope } from './docs'

type DocSearch = { edit?: boolean }

export const Route = createFileRoute('/docs/$scope/$subject/$slug')({
  validateSearch: (search: Record<string, unknown>): DocSearch => ({
    edit: search.edit === true || search.edit === '1' || search.edit === 'true' ? true : undefined,
  }),
  component: DocPage,
})

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
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    if (edit) setEditing(true)
  }, [edit])

  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title)
      setBody(doc.data.body)
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
    return <p className="text-destructive">unknown scope "{scope}"; valid: {DOC_SCOPES.join(', ')}</p>
  }

  return (
    <section>
      <PageHeader title={editing ? <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="font-sans text-[20px] font-semibold"
            /> : (doc.data?.title ?? slug)} subtitle={`${scope} \u00b7 ${subject ?? slug}`} actions={
        <div className="flex shrink-0 gap-2">
          {(editing || confirmingDelete) ? <Input aria-label="Reason" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-52" /> : null}
          {editing ? <><Button size="sm" onClick={() => save.mutate({ scope, subject, slug, title, body, reason })} disabled={save.isPending || !title || !reason.trim()}><Save size={14} />Save</Button><Button size="sm" variant="outline" onClick={cancelEdit}><X size={14} />Cancel</Button></> : <Button size="sm" variant="outline" onClick={() => { setConfirmingDelete(false); setReason(''); setEditing(true) }} disabled={!doc.data}><Pencil size={14} />Edit</Button>}
          <Button size="sm" variant="destructive" onClick={onDelete} disabled={remove.isPending || !doc.data || (confirmingDelete && !reason.trim())}><Trash2 size={14} />{confirmingDelete ? 'Confirm delete' : 'Delete'}</Button>
        </div>} />
      {doc.isPending ? <p className="text-muted-foreground">Loading doc...</p> : null}
      {doc.error ? <p className="text-destructive">{doc.error.message}</p> : null}
      {save.error ? <p className="text-destructive">{save.error.message}</p> : null}
      {remove.error ? <p className="text-destructive">{remove.error.message}</p> : null}

      {doc.data && editing ? (
        <div className="grid grid-cols-2 gap-0 border border-border">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[60vh] border-0 border-r font-mono text-[12.5px]"
          />
          <div className="min-h-[60vh] overflow-auto p-3">
            <Markdown content={body} />
          </div>
        </div>
      ) : null}

      {doc.data && !editing ? <div className="prose-copy"><Markdown content={doc.data.body} /></div> : null}
      {doc.data && !editing ? <div className="mt-8 border-t border-border pt-4">
        <h2 className="mb-3 text-sm font-semibold">History</h2>
        {history.error ? <p className="text-destructive">{history.error.message}</p> : null}
        {history.data?.map((revision) => <div key={revision.id} className="grid grid-cols-[5rem_6rem_1fr_auto] gap-3 border-b border-border py-2 text-xs">
          <span>#{revision.id} {revision.op}</span>
          <span>{revision.author}</span>
          <span>{revision.reason}</span>
          <span className="text-muted-foreground">{revision.at} · {revision.bytes} bytes</span>
        </div>)}
      </div> : null}
    </section>
  )
}
