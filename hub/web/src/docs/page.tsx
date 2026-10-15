import { useQuery } from '@tanstack/react-query'
import { useLocation, useMatch, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { hostedOrigin, isHostedMode } from '@/lib/hub-mode'
import { recordSpaces } from '@/lib/record-spaces'
import { trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { editorChrome, useArticleEditor } from './article-editor.tsx'
import { CreateDocDialog } from './create-dialog.tsx'
import { canEditDoc } from './edit-permission.ts'
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
import { docsSearchIncludesWorking, docsVisibleByStatus, resolveDocsReplacement } from './model.ts'
import { type RevisionMode, RevisionViewer, useRevisionView } from './revision-viewer.tsx'
import type { DocsTreeItem } from './types.ts'
import { docsSource, docsSourceLabel } from './types.ts'
import { useReorderableDocsTree } from './use-doc-reorder.ts'
import { useDocsDocument, useDocsSearch } from './use-docs.ts'
import { DocsView } from './view.tsx'

function enterDocEdit(
  navigate: ReturnType<typeof useNavigate>,
  selected: DocsTreeItem | null,
  source: ReturnType<typeof docsSource>,
) {
  if (!selected) return
  const location = docsLocation(selected, source)
  void navigate({ ...location, search: { ...location.search, edit: true } })
}

function canEditSelected(
  selected: DocsTreeItem | null,
  source: ReturnType<typeof docsSource>,
  memberships: Parameters<typeof canEditDoc>[1],
) {
  return Boolean(selected && canEditDoc(source, memberships, selected.spaceId))
}

function isEditingArticle(editFlag: boolean | undefined, mayEdit: boolean, hasDocument: boolean) {
  return Boolean(editFlag) && mayEdit && hasDocument
}

function docsWorkspaceReady(
  catalogPending: boolean,
  emptyChooserSet: boolean,
  identityResolved: boolean,
  atDocsRoot: boolean,
  selected: boolean,
) {
  return !catalogPending && emptyChooserSet && identityResolved && (atDocsRoot || selected)
}

function docsSourceName(
  source: ReturnType<typeof docsSource>,
  memberships: unknown,
  active?: string | null,
) {
  return docsSourceLabel(
    source,
    recordSpaces(memberships as Parameters<typeof recordSpaces>[0]).find(
      (space) => space.id === active,
    )?.name,
  )
}

const selectedRevision = (
  source: ReturnType<typeof docsSource>,
  revision: string | number | undefined,
) => (source !== 'public' && revision !== undefined ? String(revision) : undefined)

export function DocsPage() {
  const hosted = isHostedMode()
  const origin = hostedOrigin()
  const navigate = useNavigate()
  const atDocsRoot = useLocation({ select: (location) => location.pathname === '/docs' })
  const whoami = useQuery({
    ...trpc.record.whoami.queryOptions(),
    enabled: hosted && origin.kind !== 'public',
    retry: false,
  })
  const signedIn = hosted ? Boolean(whoami.data?.user && 'email' in whoami.data.user) : true
  const identityResolved = !hosted || origin.kind === 'public' || whoami.isFetched
  const source = docsSource(hosted, signedIn)
  const sourceLabel = docsSourceName(source, whoami.data?.memberships, whoami.data?.activeSpaceId)
  const detail = useMatch({ from: '/docs/$scope/$subject/$slug', shouldThrow: false })
  const params = detail?.params
  const search = detail?.search
  const [filters, setFilters] = useState<FilterSelection>(EMPTY_FILTERS)
  const [project, setProject] = useState<string | 'all'>('all')
  const [emptyChooserSet, setEmptyChooserSet] = useState(false)
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDrafts, setShowDrafts] = useState(false)
  const [showWorking, setShowWorking] = useState(false)
  const [revisionMode, setRevisionMode] = useState<RevisionMode>('version')
  const catalog = useReorderableDocsTree(source, whoami.data?.memberships)
  const includeDrafts = source !== 'public' && showDrafts
  const navigationItems = useMemo(
    () => docsVisibleByStatus(catalog.items, includeDrafts),
    [catalog.items, includeDrafts],
  )
  const includeWorking = docsSearchIncludesWorking(navigationItems, project, showWorking)
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
  useEffect(() => {
    if (!selectedId) return
    setProject(selected?.projectName ?? 'all')
    setEmptyChooserSet(true)
  }, [selectedId, selected?.projectName])
  useEffect(() => {
    if (selectedId || emptyChooserSet || catalog.isPending) return
    setProject(chooserProject(null, subjects))
    setEmptyChooserSet(true)
  }, [selectedId, emptyChooserSet, catalog.isPending, subjects])
  const reading = useDocsDocument(source, selected, selectedAudience(filters))
  const revisionId = selectedRevision(source, search?.revision)
  useEffect(() => {
    if (!revisionId) setRevisionMode('version')
  }, [revisionId])
  const revision = useRevisionView(source, reading.document, revisionId, selectedAudience(filters))
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
    includeWorking,
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
  const openRevision = useCallback(
    (id: number | string) => {
      if (!selected) return
      const location = docsLocation(selected, source)
      void navigate({ ...location, search: { ...location.search, revision: id } })
    },
    [navigate, selected, source],
  )
  const backToCurrent = useCallback(() => {
    if (!selected) return
    void navigate({ ...docsLocation(selected, source), replace: true })
  }, [navigate, selected, source])
  const mayEdit = canEditSelected(selected, source, whoami.data?.memberships)
  const editing = isEditingArticle(search?.edit, mayEdit, Boolean(reading.document))
  const editor = useArticleEditor({
    doc: reading.document,
    source,
    editing,
    onLeave: backToCurrent,
  })
  const enterEdit = useCallback(
    () => enterDocEdit(navigate, selected, source),
    [navigate, selected, source],
  )

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
        source={source}
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
        showWorking={source !== 'public' && showWorking}
        onShowWorking={setShowWorking}
        doc={reading.document}
        replacement={replacement}
        locationFor={locationFor}
        onSelect={open}
        onOpenFirst={openFirst}
        treeReorder={catalog.treeReorder}
        ready={docsWorkspaceReady(
          catalog.isPending,
          emptyChooserSet,
          identityResolved,
          atDocsRoot,
          Boolean(selected),
        )}
        searchQuery={searchQuery}
        onSearchQuery={setSearchQuery}
        searchResults={results.items}
        framed={hosted && !signedIn}
        loading={catalog.isPending}
        error={
          catalog.error?.message ??
          reading.error?.message ??
          results.error?.message ??
          revision.error ??
          null
        }
        revisionId={revisionId}
        onRevision={openRevision}
        createAction={
          source === 'local' ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New doc
            </Button>
          ) : null
        }
        {...editorChrome(
          editor,
          editing,
          mayEdit,
          enterEdit,
          revision.revision ? (
            <RevisionViewer
              revision={revision.revision}
              replacementBody={revision.replacementBody}
              onCurrent={backToCurrent}
              mode={revisionMode}
              onMode={setRevisionMode}
            />
          ) : undefined,
          revision.revision,
        )}
      />
      {editing ? editor.overlays : null}
      {source === 'local' && creating ? <CreateDocDialog open onOpenChange={setCreating} /> : null}
    </>
  )
}
