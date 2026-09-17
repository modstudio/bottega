import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { HostedDocs } from '@/components/hosted-docs'
import { compactBytes, relativeTime } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'
import { Input } from '@/ui/field/input'
import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'
import { Segmented } from '@/ui/segmented/segmented'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'

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

const deliveryOptions = [
  { value: 'inject', label: 'Inject' },
  { value: 'demand', label: 'Demand' },
]

export const Route = createFileRoute('/docs')({
  component: () => (isHostedMode() ? <HostedDocs /> : <DocsPage />),
})

function DocsPage() {
  return (
    <>
      <DocsList />
      <Outlet />
    </>
  )
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
  type Row = (typeof rows)[number]
  const columns: CollectionColumn<Row>[] = [
    { id: 'scope', label: 'Scope', render: (doc) => doc.scope },
    {
      id: 'subject',
      label: 'Subject',
      render: (doc) => <span className="text-text-muted">{doc.subject ?? '-'}</span>,
    },
    { id: 'slug', label: 'Slug', render: (doc) => <strong>{doc.slug}</strong> },
    { id: 'title', label: 'Title', render: (doc) => doc.title },
    { id: 'delivery', label: 'Delivery', render: (doc) => doc.delivery },
    {
      id: 'size',
      label: 'Size',
      numeric: true,
      render: (doc) => compactBytes(bodyBytes(doc.body)),
    },
    {
      id: 'updated',
      label: 'Updated',
      render: (doc) => <span className="text-text-muted">{relativeTime(doc.updated_at)}</span>,
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-text-muted" />,
    },
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
      <PageHeader
        title="Docs"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setScope('global')
              setSubject('')
              setSlug('')
              setTitle('')
              setDelivery('inject')
              create.reset()
              setCreating(true)
            }}
          >
            <Plus size={14} />
            New doc
          </Button>
        }
      />
      {docs.isPending ? <p className="text-text-muted">Loading docs...</p> : null}
      {docs.error ? (
        <p data-tone="error" className="text-status-text">
          {docs.error.message}
        </p>
      ) : null}
      {docs.data ? (
        <Collection
          title="Documents"
          count={rows.length}
          search={{
            query: textFilter,
            onQueryChange: setTextFilter,
            placeholder: 'Filter slug or title',
          }}
          filters={
            <Segmented
              label="Scope"
              value={scopeFilter}
              onChange={setScopeFilter}
              options={[
                { value: 'all', label: 'All' },
                ...DOC_SCOPES.map((s) => ({
                  value: s,
                  label: s.charAt(0).toUpperCase() + s.slice(1),
                })),
              ]}
            />
          }
          columns={columns}
          rows={rows}
          getKey={(doc) => `${doc.scope}:${doc.subject ?? '_'}:${doc.slug}`}
          onOpen={(doc) =>
            void navigate({
              to: '/docs/$scope/$subject/$slug',
              params: { scope: doc.scope, subject: doc.subject ?? '_', slug: doc.slug },
              search: {},
            })
          }
          empty={{
            title: 'No docs match this view.',
            hint: 'Change the scope or clear the text filter.',
          }}
        />
      ) : null}

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) setCreating(false)
        }}
        title="New doc"
        description="Creates an empty body and opens it for editing."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submitCreate}
              disabled={create.isPending || !slug || !title || (needsSubject(scope) && !subject)}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-1 text-sm">
            <span className="text-text-muted">Scope</span>
            <Select
              label="Scope"
              value={scope}
              options={DOC_SCOPES.map((value) => ({ value, label: value }))}
              onChange={(next) => {
                if (isScope(next)) setScope(next)
              }}
            />
          </div>
          {needsSubject(scope) ? (
            <div className="grid gap-1 text-sm">
              <span className="text-text-muted">Subject</span>
              <Select
                label="Subject"
                value={subject}
                options={subjectOptions.map((name) => ({ value: name, label: name }))}
                onChange={setSubject}
              />
            </div>
          ) : null}
          <label htmlFor="new-doc-slug" className="block text-sm">
            <span className="text-text-muted">Slug</span>
            <Input id="new-doc-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </label>
          <label htmlFor="new-doc-title" className="block text-sm">
            <span className="text-text-muted">Title</span>
            <Input id="new-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="grid gap-1 text-sm">
            <span className="text-text-muted">Delivery</span>
            <Select
              label="Delivery"
              value={delivery}
              options={deliveryOptions}
              onChange={(next) => setDelivery(next as 'inject' | 'demand')}
            />
          </div>
          {create.error ? (
            <p data-tone="error" className="text-status-text">
              {create.error.message}
            </p>
          ) : null}
        </div>
      </Dialog>
    </section>
  )
}

export { isScope }
