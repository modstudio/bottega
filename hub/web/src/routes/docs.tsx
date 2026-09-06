import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, Plus } from 'lucide-react'
import { PageHeader } from '@/components/design-system'
import { Button } from '@/components/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/dialog'
import { Input } from '@/components/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/tabs'
import { queryClient, trpc } from '@/trpc/client'
import { compactBytes, relativeTime } from '@/lib/format'
import { Collection, type CollectionColumn } from '@/components/collection'
import {
  DOC_SCOPES, DOC_SCOPE_SUBJECT_KIND, type DocScope,
} from '../../../../shared/docs.ts'

export { DOC_SCOPES, type DocScope }

function isScope(value: string): value is DocScope {
  return (DOC_SCOPES as readonly string[]).includes(value)
}

function needsSubject(scope: DocScope) {
  return DOC_SCOPE_SUBJECT_KIND[scope] !== null
}

function bodyBytes(body: string) {
  return new TextEncoder().encode(body).length
}

const selectClass =
  'flex h-10 w-full border border-input bg-background px-3 py-2 text-sm ' +
  'focus-visible:ring-2 focus-visible:ring-ring'

export const Route = createFileRoute('/docs')({ component: DocsPage })

function DocsPage() {
  return <><DocsList /><Outlet /></>
}

function DocsList() {
  const navigate = useNavigate()
  const docs = useQuery(trpc.doc.list.queryOptions())
  const subjects = useQuery(trpc.doc.subjects.queryOptions())
  const [scopeFilter, setScopeFilter] = useState('all')
  const [textFilter, setTextFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [scope, setScope] = useState<DocScope>('global')
  const [subject, setSubject] = useState('')
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [delivery, setDelivery] = useState<'inject' | 'demand'>('inject')

  const create = useMutation({
    ...trpc.doc.set.mutationOptions(),
    onSuccess: async (_row, input) => {
      await queryClient.invalidateQueries()
      setCreating(false)
      await navigate({
        to: '/docs/$scope/$subject/$slug',
        params: {
          scope: input.scope,
          subject: input.subject ?? '_',
          slug: input.slug,
        },
        search: { edit: true },
      })
    },
  })

  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  const subjectOptions = subjectKind === null ? [] : (subjects.data?.[subjectKind] ?? [])

  useEffect(() => {
    if (!needsSubject(scope)) {
      setSubject('')
      return
    }
    if (subject && subjectOptions.includes(subject)) return
    setSubject(subjectOptions[0] ?? '')
  }, [scope, subject, subjectOptions])

  const rows = useMemo(() => {
    const all = docs.data ?? []
    const q = textFilter.trim().toLowerCase()
    return all.filter((doc) => {
      if (scopeFilter !== 'all' && doc.scope !== scopeFilter) return false
      if (!q) return true
      return doc.slug.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q)
    })
  }, [docs.data, scopeFilter, textFilter])
  type Row = typeof rows[number]
  const columns: CollectionColumn<Row>[] = [
    { id: 'scope', label: 'Scope', render: (doc) => doc.scope },
    { id: 'subject', label: 'Subject', render: (doc) => <span className="text-muted-foreground">{doc.subject ?? '-'}</span> },
    { id: 'slug', label: 'Slug', render: (doc) => <strong>{doc.slug}</strong> },
    { id: 'title', label: 'Title', render: (doc) => doc.title },
    { id: 'delivery', label: 'Delivery', render: (doc) => doc.delivery },
    { id: 'size', label: 'Size', className: 'num', render: (doc) => compactBytes(bodyBytes(doc.body)) },
    { id: 'updated', label: 'Updated', render: (doc) => <span className="text-muted-foreground">{relativeTime(doc.updated_at)}</span> },
    { id: 'open', label: '', render: () => <ChevronRight size={14} className="text-muted-foreground" /> },
  ]

  function submitCreate() {
    if (!slug || !title) return
    if (needsSubject(scope) && !subject) return
    create.mutate({
      scope,
      subject: needsSubject(scope) ? subject : null,
      slug,
      title,
      body: '',
      reason: 'created from hub',
      delivery,
    })
  }

  return (
    <section>
      <PageHeader title="Docs" actions={<Button size="sm" onClick={() => {
          setScope('global')
          setSubject('')
          setSlug('')
          setTitle('')
          setDelivery('inject')
          create.reset()
          setCreating(true)
        }}>
          <Plus size={14} />
          New doc
        </Button>} />
      {docs.isPending ? <p className="text-muted-foreground">Loading docs...</p> : null}
      {docs.error ? <p className="text-destructive">{docs.error.message}</p> : null}
      {docs.data ? <Collection title="Documents" count={rows.length} search={{ query: textFilter, onQueryChange: setTextFilter, placeholder: 'Filter slug or title' }} filters={<Tabs value={scopeFilter} onValueChange={setScopeFilter}><TabsList><TabsTrigger value="all">All</TabsTrigger>{DOC_SCOPES.map((s) => <TabsTrigger key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</TabsTrigger>)}</TabsList></Tabs>} columns={columns} rows={rows} getKey={(doc) => `${doc.scope}:${doc.subject ?? '_'}:${doc.slug}`} onOpen={(doc) => void navigate({ to: '/docs/$scope/$subject/$slug', params: { scope: doc.scope, subject: doc.subject ?? '_', slug: doc.slug }, search: {} })} empty={{ title: 'No docs match this view.', hint: 'Change the scope or clear the text filter.' }} /> : null}

      <Dialog open={creating} onOpenChange={(open) => { if (!open) setCreating(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New doc</DialogTitle>
            <DialogDescription>Creates an empty body and opens it for editing.</DialogDescription>
          </DialogHeader>
          <label className="block text-sm">
            <span className="text-muted-foreground">Scope</span>
            <select
              className={selectClass}
              value={scope}
              onChange={(e) => {
                const next = e.target.value
                if (isScope(next)) setScope(next)
              }}
            >
              {DOC_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {needsSubject(scope) ? (
            <label className="block text-sm">
              <span className="text-muted-foreground">Subject</span>
              <select
                className={selectClass}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                {subjectOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="block text-sm">
            <span className="text-muted-foreground">Slug</span>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Delivery</span>
            <select className={selectClass} value={delivery}
              onChange={(e) => setDelivery(e.target.value as 'inject' | 'demand')}>
              <option value="inject">inject</option>
              <option value="demand">demand</option>
            </select>
          </label>
          {create.error ? <p className="text-destructive">{create.error.message}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              onClick={submitCreate}
              disabled={create.isPending || !slug || !title || (needsSubject(scope) && !subject)}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export { isScope, needsSubject }
