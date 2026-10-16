import {
  useArticleSave,
  useCreateDoc,
  useCreateDocSubjects,
  useCurrentArticle,
  useDocDelete,
  useDocFieldSave,
  useDocHistory,
  useDocSubjects,
  useDocsIdentity,
  useRevisionView,
} from '@bottega/hub-data/docs/actions'
import { useReorderableDocsTree } from '@bottega/hub-data/docs/use-doc-reorder'
import { useDocsDocument, useDocsSearch, useStoredDocument } from '@bottega/hub-data/docs/use-docs'
import { hostedOrigin, isHostedMode } from '@bottega/hub-data/hub-mode'
import { Button } from '@bottega/hub-ui/button'
import { toast } from '@bottega/hub-ui/toast'
import { Link, useBlocker, useLocation, useMatch, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { recordSpaces } from '@/lib/record-spaces'
import { editorChrome, useArticleEditor } from '../docs/article-editor.tsx'
import { CreateDocDialog } from '../docs/create-dialog.tsx'
import { type DocFieldChange, fieldWriteInput } from '../docs/doc-field-changes.ts'
import { canEditDoc } from '../docs/edit-permission.ts'
import {
  chooserProject,
  EMPTY_FILTERS,
  type FilterSelection,
  projectSubjects,
  searchSubject,
  selectedAudience,
} from '../docs/filters.ts'
import { DocsHome } from '../docs/home.tsx'
import { docsLocation } from '../docs/location.ts'
import { mapDoc, mapSearchMatch, mapTreeItem } from '../docs/map.ts'
import {
  docsSearchIncludesWorking,
  docsVisibleByStatus,
  resolveDocsReplacement,
} from '../docs/model.ts'
import { revisionComparison } from '../docs/revision-diff.ts'
import {
  type RevisionMode,
  RevisionViewer,
  revisionIdForSource,
  revisionViewError,
} from '../docs/revision-viewer.tsx'
import { isScope } from '../docs/scope.ts'
import { docsSearchInputs } from '../docs/search-input.ts'
import { orderedIdsAfterDrag, siblingKey } from '../docs/tree.ts'
import type { DocsTreeItem } from '../docs/types.ts'
import { docsSource, docsSourceLabel } from '../docs/types.ts'
import { DocsView } from '../docs/view.tsx'

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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : undefined)

export function DocsPage() {
  const hosted = isHostedMode()
  const origin = hostedOrigin()
  const navigate = useNavigate()
  const atDocsRoot = useLocation({ select: (location) => location.pathname === '/docs' })
  const whoami = useDocsIdentity(hosted && origin.kind !== 'public')
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
  const catalog = useReorderableDocsTree(
    source,
    whoami.data?.memberships,
    mapTreeItem,
    canEditDoc,
    siblingKey,
    orderedIdsAfterDrag,
  )
  const includeDrafts = source !== 'public' && showDrafts
  useEffect(() => {
    if (catalog.reorderError)
      toast.error(
        catalog.reorderError instanceof Error
          ? catalog.reorderError.message
          : 'Could not save the document order',
      )
  }, [catalog.reorderError])
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
  const reading = useDocsDocument(source, selected, selectedAudience(filters), mapDoc, isScope)
  const revisionId = selectedRevision(source, search?.revision)
  useEffect(() => {
    if (!revisionId) setRevisionMode('version')
  }, [revisionId])
  const revision = useRevisionView(
    source,
    reading.document,
    revisionId,
    selectedAudience(filters),
    revisionIdForSource,
    revisionComparison,
    revisionViewError,
  )
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
    docsSearchInputs,
    mapSearchMatch,
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
  const storedDocument = useStoredDocument(reading.document, source, editing || mayEdit, isScope)
  const saveAction = useArticleSave(source, reading.document, storedDocument?.revision, isScope)
  const fetchCurrentArticle = useCurrentArticle(source, reading.document, isScope)
  const [leaveRequested, setLeaveRequested] = useState(false)
  const blocker = useBlocker({
    shouldBlockFn: () => leaveRequested,
    enableBeforeUnload: () => leaveRequested,
    withResolver: true,
    disabled: !editing,
  })
  const editor = useArticleEditor({
    doc: reading.document,
    editing,
    onLeave: backToCurrent,
    storedDocument,
    saveAction,
    fetchCurrentArticle,
    onLeaveRequest: setLeaveRequested,
    leaveBlocker: {
      blocked: blocker.status === 'blocked',
      onKeep: () => blocker.reset?.(),
      onDiscard: () => blocker.proceed?.(),
    },
  })
  const field = useDocFieldSave<DocFieldChange>(
    source,
    reading.document,
    storedDocument,
    isScope,
    (mode, change) => {
      if (!reading.document || !storedDocument) return null
      if (mode === 'hosted') {
        return fieldWriteInput(
          mode,
          { ...reading.document, spaceId: reading.document.spaceId! },
          { ...storedDocument, revision: storedDocument.revision! },
          change,
        )
      }
      return fieldWriteInput(mode, reading.document, storedDocument, change)
    },
  )
  const subjectCatalog = useDocSubjects(
    source,
    reading.document,
    Boolean(mayEdit && reading.document?.kind === 'article'),
  )
  const history = useDocHistory(source, reading.document, selectedAudience(filters))
  const deleteAction = useDocDelete(source, reading.document, storedDocument?.revision, isScope)
  const createAction = useCreateDoc()
  const createSubjects = useCreateDocSubjects(creating)
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
        error={errorMessage(catalog.error) ?? errorMessage(results.error) ?? null}
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
        canShowWorking={source !== 'public'}
        showWorking={source !== 'public' && showWorking}
        onShowWorking={setShowWorking}
        doc={reading.document}
        replacement={replacement}
        locationFor={locationFor}
        renderLink={(location, children, className) => (
          <Link {...location} className={className}>
            {children}
          </Link>
        )}
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
        showHistory={source !== 'public'}
        factsControls={
          mayEdit
            ? {
                field,
                items: catalog.items,
                subjects: subjectCatalog,
                remove: {
                  ...deleteAction,
                  async run(reason) {
                    const removed = await deleteAction.run(reason)
                    if (removed) await navigate({ to: '/docs' })
                  },
                },
              }
            : undefined
        }
        field={mayEdit ? field : undefined}
        history={history}
        loading={catalog.isPending}
        error={
          errorMessage(catalog.error) ??
          errorMessage(reading.error) ??
          errorMessage(results.error) ??
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
      {source === 'local' && creating ? (
        <CreateDocDialog
          open
          onOpenChange={setCreating}
          subjects={createSubjects.data}
          create={createAction}
          onCreated={async (address) => {
            await navigate({
              to: '/docs/$scope/$subject/$slug',
              params: {
                scope: address.scope,
                subject: address.subject ?? '_',
                slug: address.slug,
              },
              search: { edit: true },
            })
          }}
        />
      ) : null}
    </>
  )
}
