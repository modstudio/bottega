import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, Outlet, useMatches, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, Plus } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/design-system'
import { Button } from '@/components/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/dialog'
import { Input } from '@/components/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/tabs'
import { queryClient, trpc } from '@/trpc/client'
import { compactBytes, relativeTime } from '@/lib/format'
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
  const matches = useMatches()
  const leaf = matches[matches.length - 1]
  if (leaf && leaf.routeId !== '/docs') return <Outlet />
  return <DocsList />
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

  function submitCreate() {
    if (!slug || !title) return
    if (needsSubject(scope) && !subject) return
    create.mutate({
      scope,
      subject: needsSubject(scope) ? subject : null,
      slug,
      title,
      body: '',
    })
  }

  return (
    <section>
      <PageHeader title="Docs" actions={<Button size="sm" onClick={() => {
          setScope('global')
          setSubject('')
          setSlug('')
          setTitle('')
          create.reset()
          setCreating(true)
        }}>
          <Plus size={14} />
          New doc
        </Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={scopeFilter} onValueChange={setScopeFilter}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            {DOC_SCOPES.map((s) => (
              <TabsTrigger key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Filter slug or title"
          className="h-9 max-w-xs"
        />
      </div>
      {docs.isPending ? <p className="text-muted-foreground">Loading docs...</p> : null}
      {docs.error ? <p className="text-destructive">{docs.error.message}</p> : null}
      {docs.data ? (
        <div className="border border-border">
          <Table className="text-[12.5px]">
            <TableHeader>
              <TableRow>
                <TableHead className="h-9 px-3">Scope</TableHead>
                <TableHead className="h-9 px-3">Subject</TableHead>
                <TableHead className="h-9 px-3">Slug</TableHead>
                <TableHead className="h-9 px-3">Title</TableHead>
                <TableHead className="num">Size</TableHead>
                <TableHead className="h-9 px-3">Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((doc) => (
                <TableRow
                  key={`${doc.scope}:${doc.subject ?? '_'}:${doc.slug}`}
                  className="data-table-link relative"
                >
                  <TableCell className="px-3 py-2">{doc.scope}</TableCell>
                  <TableCell className="px-3 py-2 text-muted-foreground">{doc.subject ?? '-'}</TableCell>
                  <TableCell className="max-w-48 truncate font-semibold" title={doc.slug}><Link className="row-link" to="/docs/$scope/$subject/$slug" params={{ scope: doc.scope, subject: doc.subject ?? '_', slug: doc.slug }}>{doc.slug}</Link></TableCell>
                  <TableCell className="px-3 py-2">{doc.title}</TableCell>
                  <TableCell className="num">{compactBytes(bodyBytes(doc.body))}</TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(doc.updated_at)}</TableCell>
                  <TableCell><ChevronRight size={14} className="text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length ? <EmptyState title="No docs match this view." hint="Change the scope or clear the text filter." /> : null}
        </div>
      ) : null}

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
