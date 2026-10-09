import { useQuery } from '@tanstack/react-query'
import { useMatch, useNavigate } from '@tanstack/react-router'
import { History, Pencil, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { hostedOrigin, isHostedMode } from '@/lib/hub-mode'
import { recordSpaces } from '@/lib/record-spaces'
import { trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { CreateDocDialog } from './create-dialog.tsx'
import {
  chooserProject,
  EMPTY_FILTERS,
  type FilterSelection,
  projectSubjects,
  searchSubject,
  selectedAudience,
} from './filters.ts'
import { DocsHome } from './home.tsx'
import { docsLocation } from './location.ts'
import { docsVisibleByStatus, resolveDocsReplacement } from './model.ts'
import type { DocsTreeItem } from './types.ts'
import { docsSource, docsSourceLabel } from './types.ts'
import { useDocsDocument, useDocsSearch, useDocsTree } from './use-docs.ts'
import { DocsView } from './view.tsx'

export function DocsPage() {
  const hosted = isHostedMode()
  const origin = hostedOrigin()
  const navigate = useNavigate()
  const whoami = useQuery({
    ...trpc.record.whoami.queryOptions(),
    enabled: hosted && origin.kind !== 'public',
    retry: false,
  })
  const signedIn = hosted ? Boolean(whoami.data?.user && 'email' in whoami.data.user) : true
  const identityResolved = !hosted || origin.kind === 'public' || whoami.isFetched
  const source = docsSource(hosted, signedIn)
  const sourceLabel = docsSourceLabel(
    source,
    recordSpaces(whoami.data?.memberships).find((space) => space.id === whoami.data?.activeSpaceId)
      ?.name,
  )
  const detail = useMatch({ from: '/docs/$scope/$subject/$slug', shouldThrow: false })
  const params = detail?.params
  const search = detail?.search
  const [filters, setFilters] = useState<FilterSelection>(EMPTY_FILTERS)
  const [project, setProject] = useState<string | 'all'>('all')
  const [emptyChooserSet, setEmptyChooserSet] = useState(false)
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDrafts, setShowDrafts] = useState(false)
  const catalog = useDocsTree(source)
  const includeDrafts = source !== 'public' && showDrafts
  const navigationItems = useMemo(
    () => docsVisibleByStatus(catalog.items, includeDrafts),
    [catalog.items, includeDrafts],
  )
  const subjects = useMemo(() => projectSubjects(navigationItems), [navigationItems])
  const selected = useMemo(() => {
    if (!params) return null
    const subject = params.subject === '_' ? null : params.subject
    return (
      catalog.items.find((item) => (search?.id ? item.id === search.id : false)) ??
      catalog.items.find(
        (item) =>
          item.scope === params.scope && item.subject === subject && item.slug === params.slug,
      ) ??
      null
    )
  }, [catalog.items, params, search?.id])
  const selectedId = selected?.id
  const selectedProject = selected?.projectName
  useEffect(() => {
    if (!selectedId) return
    setProject(selectedProject ?? 'all')
    setEmptyChooserSet(true)
  }, [selectedId, selectedProject])
  useEffect(() => {
    if (selectedId || emptyChooserSet || catalog.isPending) return
    setProject(chooserProject(null, subjects))
    setEmptyChooserSet(true)
  }, [selectedId, emptyChooserSet, catalog.isPending, subjects])
  const reading = useDocsDocument(source, selected)
  const replacement = useMemo(
    () => resolveDocsReplacement(reading.document, catalog.items),
    [reading.document, catalog.items],
  )
  const results = useDocsSearch(
    source,
    searchQuery,
    selectedAudience(filters),
    searchSubject(project, navigationItems),
    includeDrafts,
  )

  const open = useCallback(
    (item: DocsTreeItem, replace = false) => {
      void navigate({
        ...docsLocation(item, source),
        replace,
      })
    },
    [navigate, source],
  )
  const openFirst = useCallback((item: DocsTreeItem) => open(item, true), [open])
  const locationFor = useCallback((item: DocsTreeItem) => docsLocation(item, source), [source])

  if (source === 'public' && identityResolved && !selected) {
    return (
      <DocsHome
        sourceLabel={sourceLabel}
        items={catalog.items}
        results={results.items}
        query={searchQuery}
        onQuery={setSearchQuery}
        onSelect={open}
        loading={catalog.isPending}
        error={catalog.error?.message ?? results.error?.message ?? null}
      />
    )
  }

  return (
    <>
      <DocsView
        sourceLabel={sourceLabel}
        items={catalog.items}
        selectedId={selected?.id ?? null}
        filters={filters}
        onFilters={setFilters}
        project={project}
        onProject={setProject}
        signedIn={signedIn}
        showProjectChooser={signedIn}
        showDrafts={includeDrafts}
        onShowDrafts={setShowDrafts}
        canShowDrafts={source !== 'public'}
        doc={reading.document}
        replacement={replacement}
        locationFor={locationFor}
        onSelect={open}
        onOpenFirst={openFirst}
        ready={!catalog.isPending && emptyChooserSet && identityResolved}
        searchQuery={searchQuery}
        onSearchQuery={setSearchQuery}
        searchResults={results.items}
        framed={hosted && !signedIn}
        loading={catalog.isPending}
        error={catalog.error?.message ?? reading.error?.message ?? results.error?.message ?? null}
        createAction={
          source === 'local' ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New doc
            </Button>
          ) : null
        }
        localActions={
          source === 'local' && selected ? (
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: '/docs/$scope/$subject/$slug',
                    params: {
                      scope: selected.scope,
                      subject: selected.subject ?? '_',
                      slug: selected.slug,
                    },
                    search: { edit: true },
                  })
                }
              >
                <Pencil size={14} />
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: '/docs/$scope/$subject/$slug',
                    params: {
                      scope: selected.scope,
                      subject: selected.subject ?? '_',
                      slug: selected.slug,
                    },
                    search: { history: true },
                  })
                }
              >
                <History size={14} />
                History
              </Button>
            </div>
          ) : null
        }
      />
      {source === 'local' && creating ? <CreateDocDialog open onOpenChange={setCreating} /> : null}
    </>
  )
}
