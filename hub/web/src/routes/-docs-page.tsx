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
import { useDocsMode } from '@bottega/hub-data/docs/mode'
import { useReorderableDocsTree } from '@bottega/hub-data/docs/use-doc-reorder'
import {
  type DocsSource,
  useDocsDocument,
  useDocsSearch,
  useStoredDocument,
} from '@bottega/hub-data/docs/use-docs'
import { hostedOrigin, isHostedMode } from '@bottega/hub-data/hub-mode'
import { Button } from '@bottega/hub-ui/button'
import { toast } from '@bottega/hub-ui/toast'
import { Link, useBlocker, useLocation, useMatch, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { recordSpaces } from '@/lib/record-spaces'
import { editorChrome, useArticleEditor } from '../docs/article-editor.tsx'
import { CreateDocDialog } from '../docs/create-dialog.tsx'
import { type DocFieldChange, fieldChangeReason } from '../docs/doc-field-changes.ts'
import {
  chooserProject,
  EMPTY_FILTERS,
  type FilterSelection,
  projectSubjects,
  searchSubject,
  selectedAudience,
} from '../docs/filters.ts'
import { DocsHome } from '../docs/home.tsx'
import { mapDoc, mapSearchMatch, mapTreeItem } from '../docs/map.ts'
import {
  docsSearchIncludesWorking,
  docsVisibleByStatus,
  resolveDocsReplacement,
} from '../docs/model.ts'
import { revisionComparison } from '../docs/revision-diff.ts'
import { type RevisionMode, RevisionViewer, revisionViewError } from '../docs/revision-viewer.tsx'
import { isScope } from '../docs/scope.ts'
import { orderedIdsAfterDrag, siblingKey } from '../docs/tree.ts'
import type { DocsDoc, DocsTreeItem } from '../docs/types.ts'
import { DocsView } from '../docs/view.tsx'

function enterDocEdit(
  navigate: ReturnType<typeof useNavigate>,
  selected: DocsTreeItem | null,
  locationFor: (item: DocsTreeItem) => ReturnType<ReturnType<typeof useDocsMode>['locationFor']>,
) {
  if (!selected) return
  const location = locationFor(selected)
  void navigate({ ...location, search: { ...location.search, edit: true } })
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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : undefined)

function useDocsRouteNavigation(
  navigate: ReturnType<typeof useNavigate>,
  selected: DocsTreeItem | null,
  locationFor: (item: DocsTreeItem) => ReturnType<ReturnType<typeof useDocsMode>['locationFor']>,
) {
  const open = useCallback(
    (item: DocsTreeItem, replace = false) => {
      void navigate({ ...locationFor(item), replace })
    },
    [navigate, locationFor],
  )
  const openFirst = useCallback((item: DocsTreeItem) => open(item, true), [open])
  const openRevision = useCallback(
    (id: number | string) => {
      if (!selected) return
      const location = locationFor(selected)
      void navigate({ ...location, search: { ...location.search, revision: id } })
    },
    [navigate, selected, locationFor],
  )
  const backToCurrent = useCallback(() => {
    if (selected) void navigate({ ...locationFor(selected), replace: true })
  }, [navigate, selected, locationFor])
  const enterEdit = useCallback(
    () => enterDocEdit(navigate, selected, locationFor),
    [navigate, selected, locationFor],
  )
  return { open, openFirst, locationFor, openRevision, backToCurrent, enterEdit }
}

function useArticleActions(
  source: DocsSource,
  doc: DocsDoc | null,
  editing: boolean,
  mayEdit: boolean,
  onLeave: () => void,
) {
  const storedDocument = useStoredDocument(doc, source, editing || mayEdit, isScope)
  const saveAction = useArticleSave(source, doc, storedDocument?.revision, isScope)
  const fetchCurrentArticle = useCurrentArticle(source, doc, isScope, saveAction.reset)
  const leaveRequest = useRef<() => boolean>(() => false)
  const shouldBlockLeave = useCallback(() => leaveRequest.current(), [])
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockLeave,
    enableBeforeUnload: shouldBlockLeave,
    withResolver: true,
    disabled: !editing,
  })
  const editor = useArticleEditor({
    doc,
    editing,
    onLeave,
    storedDocument,
    saveAction,
    fetchCurrentArticle,
    onLeaveRequest: (request) => {
      leaveRequest.current = request
    },
    leaveBlocker: {
      blocked: blocker.status === 'blocked',
      onKeep: () => blocker.reset?.(),
      onDiscard: () => blocker.proceed?.(),
    },
  })
  return { editor, storedDocument }
}

function useDocumentActions(
  source: DocsSource,
  doc: DocsDoc | null,
  mayEdit: boolean,
  storedDocument: ReturnType<typeof useStoredDocument>,
  audience: ReturnType<typeof selectedAudience>,
  creating: boolean,
) {
  const fieldAction = useDocFieldSave(source, doc, storedDocument, isScope)
  const field = {
    ...fieldAction,
    run(change: DocFieldChange) {
      return fieldAction.run(change, fieldChangeReason(change))
    },
  }
  const subjectCatalog = useDocSubjects(source, doc, Boolean(mayEdit && doc?.kind === 'article'))
  return {
    field,
    subjectCatalog,
    history: useDocHistory(source, doc, audience),
    deleteAction: useDocDelete(source, doc, storedDocument?.revision, isScope),
    createAction: useCreateDoc(),
    createSubjects: useCreateDocSubjects(creating),
  }
}

function useDocsSelection(
  source: DocsSource,
  memberships: readonly Record<string, unknown>[] | undefined,
  params: { scope: string; subject: string; slug: string } | undefined,
  search: { id?: string } | undefined,
  includeDrafts: boolean,
) {
  const [project, setProject] = useState<string | 'all'>('all')
  const [emptyChooserSet, setEmptyChooserSet] = useState(false)
  const catalog = useReorderableDocsTree(
    source,
    memberships,
    mapTreeItem,
    siblingKey,
    orderedIdsAfterDrag,
  )
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
  useEffect(() => {
    if (!selected) return
    setProject(selected.projectName ?? 'all')
    setEmptyChooserSet(true)
  }, [selected])
  useEffect(() => {
    if (selected || emptyChooserSet || catalog.isPending) return
    setProject(chooserProject(null, subjects))
    setEmptyChooserSet(true)
  }, [selected, emptyChooserSet, catalog.isPending, subjects])
  return {
    catalog,
    includeDrafts,
    navigationItems,
    selected,
    project,
    setProject,
    emptyChooserSet,
  }
}

function RouteCreateDialog({
  show,
  creating,
  onCreating,
  subjects,
  create,
  navigate,
}: {
  show: boolean
  creating: boolean
  onCreating: (creating: boolean) => void
  subjects: Parameters<typeof CreateDocDialog>[0]['subjects']
  create: Parameters<typeof CreateDocDialog>[0]['create']
  navigate: ReturnType<typeof useNavigate>
}) {
  if (!show || !creating) return null
  return (
    <CreateDocDialog
      open
      onOpenChange={onCreating}
      subjects={subjects}
      create={create}
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
  )
}

function routeHubMode() {
  const hosted = isHostedMode()
  return { hosted, origin: hostedOrigin() }
}

function useDocsRevision(
  source: DocsSource,
  doc: DocsDoc | null,
  revisionId: string | undefined,
  audience: ReturnType<typeof selectedAudience>,
) {
  const [revisionMode, setRevisionMode] = useState<RevisionMode>('version')
  useEffect(() => {
    if (!revisionId) setRevisionMode('version')
  }, [revisionId])
  const revision = useRevisionView(
    source,
    doc,
    revisionId,
    audience,
    revisionComparison,
    revisionViewError,
  )
  return { revisionMode, setRevisionMode, revision }
}

function useDocsEnvironment() {
  const { hosted, origin } = routeHubMode()
  const navigate = useNavigate()
  const atDocsRoot = useLocation({ select: (location) => location.pathname === '/docs' })
  const whoami = useDocsIdentity(hosted && origin.kind !== 'public')
  const signedIn = hosted ? Boolean(whoami.data?.user && 'email' in whoami.data.user) : true
  const identityResolved = !hosted || origin.kind === 'public' || whoami.isFetched
  const activeSpaceName = recordSpaces(whoami.data?.memberships).find(
    (space) => space.id === whoami.data?.activeSpaceId,
  )?.name
  const mode = useDocsMode(hosted, signedIn, whoami.data?.memberships, activeSpaceName)
  return { hosted, navigate, atDocsRoot, whoami, signedIn, identityResolved, mode }
}

function useDocsPageModel() {
  const { hosted, navigate, atDocsRoot, whoami, signedIn, identityResolved, mode } =
    useDocsEnvironment()
  const { source } = mode
  const detail = useMatch({ from: '/docs/$scope/$subject/$slug', shouldThrow: false })
  const search = detail?.search
  const [filters, setFilters] = useState<FilterSelection>(EMPTY_FILTERS)
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDrafts, setShowDrafts] = useState(false)
  const [showWorking, setShowWorking] = useState(false)
  const {
    catalog,
    includeDrafts,
    navigationItems,
    selected,
    project,
    setProject,
    emptyChooserSet,
  } = useDocsSelection(
    source,
    whoami.data?.memberships,
    detail?.params,
    search,
    mode.includeDrafts(showDrafts),
  )
  const includeWorking = docsSearchIncludesWorking(navigationItems, project, showWorking)
  const reading = useDocsDocument(source, selected, selectedAudience(filters), mapDoc, isScope)
  const revisionId = mode.selectedRevision(search?.revision)
  const { revisionMode, setRevisionMode, revision } = useDocsRevision(
    source,
    reading.document,
    revisionId,
    selectedAudience(filters),
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
    mapSearchMatch,
  )

  const { open, openFirst, locationFor, openRevision, backToCurrent, enterEdit } =
    useDocsRouteNavigation(navigate, selected, mode.locationFor)
  const mayEdit = mode.canEdit(selected)
  const editing = isEditingArticle(search?.edit, mayEdit, Boolean(reading.document))
  const { editor, storedDocument } = useArticleActions(
    source,
    reading.document,
    editing,
    mayEdit,
    backToCurrent,
  )
  const { field, subjectCatalog, history, deleteAction, createAction, createSubjects } =
    useDocumentActions(
      source,
      reading.document,
      mayEdit,
      storedDocument,
      selectedAudience(filters),
      creating,
    )

  return Object.assign(
    { hosted, navigate, atDocsRoot, whoami, signedIn, identityResolved, source, mode },
    {
      filters,
      setFilters,
      creating,
      setCreating,
      searchQuery,
      setSearchQuery,
      showDrafts,
      setShowDrafts,
      showWorking,
      setShowWorking,
      revisionMode,
      setRevisionMode,
    },
    { catalog, includeDrafts, selected, project, setProject, emptyChooserSet },
    { reading, revisionId, revision, replacement, results },
    { open, openFirst, locationFor, openRevision, backToCurrent, enterEdit },
    { mayEdit, editing, editor, field, subjectCatalog, history },
    { deleteAction, createAction, createSubjects },
  )
}

type DocsPageModel = ReturnType<typeof useDocsPageModel>

function PublicDocsHome({ model }: { model: DocsPageModel }) {
  if (!model.mode.isPublic || !model.identityResolved || model.selected) return null
  return (
    <DocsHome
      sourceLabel={model.mode.label}
      items={model.catalog.items}
      results={model.results.items}
      query={model.searchQuery}
      onQuery={model.setSearchQuery}
      onSelect={model.open}
      loading={model.catalog.isPending}
      error={errorMessage(model.catalog.error) ?? errorMessage(model.results.error) ?? null}
    />
  )
}

function docsFactsControls(model: DocsPageModel) {
  if (!model.mayEdit) return undefined
  return {
    field: model.field,
    items: model.catalog.items,
    subjects: model.subjectCatalog,
    remove: {
      ...model.deleteAction,
      async run(reason: string) {
        const removed = await model.deleteAction.run(reason)
        if (removed) await model.navigate({ to: '/docs' })
      },
    },
  }
}

function DocsWorkspaceView({ model }: { model: DocsPageModel }) {
  const revisionView = model.revision.revision ? (
    <RevisionViewer
      revision={model.revision.revision}
      replacementBody={model.revision.replacementBody}
      onCurrent={model.backToCurrent}
      mode={model.revisionMode}
      onMode={model.setRevisionMode}
    />
  ) : undefined
  return (
    <DocsView
      sourceLabel={model.mode.label}
      items={model.catalog.items}
      selectedId={model.selected?.id ?? null}
      filters={model.filters}
      onFilters={model.setFilters}
      project={model.project}
      onProject={model.setProject}
      signedIn={model.signedIn}
      showProjectChooser={model.signedIn}
      showDrafts={model.includeDrafts}
      onShowDrafts={model.setShowDrafts}
      canShowDrafts={model.mode.canShowDrafts}
      canShowWorking={model.mode.canShowWorking}
      showWorking={model.mode.showWorking(model.showWorking)}
      onShowWorking={model.setShowWorking}
      doc={model.reading.document}
      replacement={model.replacement}
      locationFor={model.locationFor}
      renderLink={(location, children, className) => (
        <Link {...location} className={className}>
          {children}
        </Link>
      )}
      onSelect={model.open}
      onOpenFirst={model.openFirst}
      treeReorder={model.catalog.treeReorder}
      ready={docsWorkspaceReady(
        model.catalog.isPending,
        model.emptyChooserSet,
        model.identityResolved,
        model.atDocsRoot,
        Boolean(model.selected),
      )}
      searchQuery={model.searchQuery}
      onSearchQuery={model.setSearchQuery}
      searchResults={model.results.items}
      framed={model.hosted && !model.signedIn}
      showHistory={model.mode.showHistory}
      factsControls={docsFactsControls(model)}
      field={model.mayEdit ? model.field : undefined}
      history={model.history}
      loading={model.catalog.isPending}
      error={
        errorMessage(model.catalog.error) ??
        errorMessage(model.reading.error) ??
        errorMessage(model.results.error) ??
        model.revision.error ??
        null
      }
      revisionId={model.revisionId}
      onRevision={model.openRevision}
      createAction={
        model.mode.canCreate ? (
          <Button variant="primary" size="sm" onClick={() => model.setCreating(true)}>
            <Plus size={14} />
            New doc
          </Button>
        ) : null
      }
      {...editorChrome(
        model.editor,
        model.editing,
        model.mayEdit,
        model.enterEdit,
        revisionView,
        model.revision.revision,
      )}
    />
  )
}

function DocsWorkspace({ model }: { model: DocsPageModel }) {
  return (
    <>
      <DocsWorkspaceView model={model} />
      {model.editing ? model.editor.overlays : null}
      <RouteCreateDialog
        show={model.mode.canCreate}
        creating={model.creating}
        onCreating={model.setCreating}
        subjects={model.createSubjects.data}
        create={model.createAction}
        navigate={model.navigate}
      />
    </>
  )
}

export function DocsPage() {
  const model = useDocsPageModel()
  if (model.mode.isPublic && model.identityResolved && !model.selected)
    return <PublicDocsHome model={model} />
  return <DocsWorkspace model={model} />
}
