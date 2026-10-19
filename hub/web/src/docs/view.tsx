import { Button } from '@bottega/hub-ui/button'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { Drawer } from '@bottega/hub-ui/drawer'
import { Kbd } from '@bottega/hub-ui/kbd'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { Popover } from '@bottega/hub-ui/popover'
import { mergeClasses as classes } from '@bottega/hub-ui/text/variant'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { useHeldPanel } from '@bottega/hub-views/detail-rail/use-held-panel'
import { PanelLeft } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldSave } from './doc-field-controls.tsx'
import { DocsFacts, type DocsFactsControls } from './facts.tsx'
import { FilterPanel } from './filter-panel.tsx'
import {
  DOC_AUDIENCE_LABELS,
  type FilterSelection,
  type OfferedFilter,
  selectedAudience,
} from './filters.ts'
import type { DocsLocation } from './location.ts'
import { docsViewModel, docsVisibleByStatus } from './model.ts'
import { DocsReading } from './reading.tsx'
import { SearchDialog } from './search.tsx'
import { breadcrumb, treePath } from './tree.ts'
import { GroupedTree, TreeList } from './tree-view.tsx'
import type * as Docs from './types.ts'

export type DocsViewProps = {
  sourceLabel: string
  items: readonly Docs.DocsTreeItem[]
  selectedId: string | null
  filters: FilterSelection
  onFilters: (filters: FilterSelection) => void
  project: string | 'all'
  onProject: (project: string | 'all') => void
  signedIn: boolean
  showProjectChooser: boolean
  showDrafts: boolean
  onShowDrafts: (show: boolean) => void
  canShowDrafts: boolean
  canShowWorking: boolean
  showWorking: boolean
  onShowWorking: (show: boolean) => void
  doc: Docs.DocsDoc | null
  replacement: Docs.DocsTreeItem | null
  locationFor: (item: Docs.DocsTreeItem) => DocsLocation
  renderLink: (location: DocsLocation, children: ReactNode, className?: string) => ReactNode
  onSelect: (item: Docs.DocsTreeItem) => void
  onOpenFirst: (item: Docs.DocsTreeItem) => void
  ready: boolean
  searchQuery: string
  onSearchQuery: (query: string) => void
  searchResults: readonly Docs.DocsSearchMatch[]
  framed: boolean
  headerAction?: ReactNode
  createAction?: ReactNode
  loading?: boolean
  error?: string | null
  revisionId?: string
  onRevision?: (id: number | string) => void
  bodyView?: ReactNode
  viewedRevision?: { title: string; body: string } | null
  editing?: boolean
  editBand?: ReactNode
  banner?: ReactNode
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  field?: FieldSave
  showHistory: boolean
  factsControls?: DocsFactsControls
  history: Parameters<typeof DocsFacts>[0]['history']
  canManage?: boolean
  treeReorder?: {
    canReorder: (item: Docs.DocsTreeItem) => boolean
    onReorder: (activeId: string, overId: string) => void
  }
}

type DocsControlsProps = {
  showProjectChooser: boolean
  project: string | 'all'
  onProject: (project: string | 'all') => void
  subjects: readonly string[]
  offered: OfferedFilter[]
  chosen: FilterSelection
  onFilters: (next: FilterSelection) => void
  inView: number
  active: number
  createAction?: ReactNode
  showDrafts: boolean
  onShowDrafts: (show: boolean) => void
  canShowDrafts: boolean
  showWorking: boolean
  onShowWorking: (show: boolean) => void
  canShowWorking: boolean
  /** On a phone, the band's first cell opens the document list. */
  onShowList?: () => void
  /** On a phone, the open document's own actions, such as Edit, join the band's actions. */
  docActions?: ReactNode
}

function ProjectSelect({
  project,
  subjects,
  onProject,
  size,
}: Pick<DocsControlsProps, 'project' | 'subjects' | 'onProject'> & { size?: 'sm' }) {
  return (
    <Select
      label="Project"
      size={size}
      value={project}
      onChange={(value) => onProject(value === 'all' ? 'all' : value)}
      options={[
        ...subjects.map((name) => ({ value: name, label: name })),
        { value: 'all', label: 'All projects' },
      ]}
    />
  )
}

/** On a phone every control folds into one band; each cell opens the same tabbed sheet. */
function PhoneDocsControls({
  projectSelect,
  filterPanel,
  active,
  onShowList,
  actions,
}: {
  projectSelect?: ReactNode
  filterPanel?: ReactNode
  active: number
  onShowList?: () => void
  actions?: ReactNode
}) {
  return (
    <ToolbarBand
      panels={
        onShowList
          ? [{ id: 'documents', label: 'Documents', icon: PanelLeft, onOpen: onShowList }]
          : []
      }
      scope={projectSelect}
      filters={filterPanel}
      filtersActive={active > 0}
      actions={actions}
    />
  )
}

/** The project chooser, the filter panel and the create action: one group, wherever the page puts it. */
function DocsControls(props: DocsControlsProps) {
  const { showProjectChooser, active, createAction, onShowList, docActions } = props
  const phone = useMediaQuery(PHONE_QUERY)
  const filterPanel =
    props.offered.length || props.canShowDrafts || props.canShowWorking ? (
      <FilterPanel
        offered={props.offered}
        chosen={props.chosen}
        onChange={props.onFilters}
        total={props.inView}
        drafts={
          props.canShowDrafts ? { shown: props.showDrafts, onChange: props.onShowDrafts } : null
        }
        working={
          props.canShowWorking ? { shown: props.showWorking, onChange: props.onShowWorking } : null
        }
      />
    ) : undefined
  if (phone) {
    return (
      <PhoneDocsControls
        projectSelect={showProjectChooser ? <ProjectSelect {...props} /> : undefined}
        filterPanel={filterPanel}
        active={active}
        onShowList={onShowList}
        actions={
          docActions || createAction ? (
            <>
              {docActions}
              {createAction}
            </>
          ) : undefined
        }
      />
    )
  }
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {showProjectChooser ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-text-muted text-xs tracking-[0.14em] uppercase">
            Project
          </span>
          <ProjectSelect {...props} size="sm" />
        </div>
      ) : null}
      {filterPanel ? (
        <Popover
          label="Filters"
          align="end"
          trigger={
            <Button size="sm">
              Filter
              {active ? (
                <span className="bg-accent-fill px-1.5 font-mono text-accent-on-fill text-xs">
                  {active}
                </span>
              ) : null}
            </Button>
          }
        >
          {filterPanel}
        </Popover>
      ) : null}
      {createAction}
    </div>
  )
}

/** The public site's own row above the docs; the dashboard carries the controls in its page header. */
function DocsChrome({ controls }: { controls: ReactNode }) {
  return (
    <div className="docs-chrome-rule relative z-20 bg-inherit lg:sticky lg:top-(--docs-top)">
      <div className="mx-auto flex w-full min-h-(--docs-chrome-h) max-w-(--docs-width) flex-wrap items-center justify-between gap-3 px-5 py-2">
        <div className="font-serif text-lg">User guide</div>
        {controls}
      </div>
    </div>
  )
}

function DocsRail({
  tree,
  groups,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onSearch,
  loading,
  emptyMessage,
  treeReorder,
  inDrawer = false,
}: {
  tree: readonly Docs.TreeNode[]
  groups: readonly Docs.DocsTreeGroup[] | null
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: Docs.DocsTreeItem) => void
  onSearch: () => void
  loading?: boolean
  emptyMessage: string
  treeReorder?: DocsViewProps['treeReorder']
  /** In the phone drawer the list fills the drawer instead of capping its height. */
  inDrawer?: boolean
}) {
  const hasTree = groups ? groups.length > 0 : tree.length > 0
  const panel = useRef<HTMLElement>(null)
  useHeldPanel(panel)
  return (
    <nav
      ref={panel}
      aria-label="Documents"
      className={
        inDrawer
          ? 'flex h-full flex-col p-4'
          : 'flex max-h-[min(24rem,70dvh)] flex-col border-border-default border-b p-5 lg:sticky lg:top-(--docs-stick) lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:border-b-0'
      }
    >
      <button
        type="button"
        onClick={onSearch}
        className="mb-4 flex h-control-md w-full shrink-0 items-center justify-between border border-border-default bg-surface-page px-2.5 text-left text-md text-text-muted transition-colors duration-(--duration-fast) hover:border-border-strong"
      >
        <span>Search docs</span>
        <Kbd>/</Kbd>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? <p className="text-md text-text-muted">Loading docs…</p> : null}
        {hasTree ? (
          groups ? (
            <GroupedTree
              groups={groups}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              {...treeReorder}
            />
          ) : (
            <TreeList
              nodes={tree}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              {...treeReorder}
            />
          )
        ) : loading ? null : (
          <p className="mt-4 text-md text-text-muted">{emptyMessage}</p>
        )}
      </div>
    </nav>
  )
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function useSearchHotkey(open: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      const target = event.target
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      event.preventDefault()
      open()
    }
    window.document.addEventListener('keydown', onKey)
    return () => window.document.removeEventListener('keydown', onKey)
  }, [open])
}

function filtersHiding(item: Docs.DocsTreeItem, chosen: FilterSelection): FilterSelection {
  const next = { ...chosen }
  if (next.scope && next.scope !== item.scope) next.scope = null
  if (next.delivery && next.delivery !== item.delivery) next.delivery = null
  return next
}

function sameFilters(left: FilterSelection, right: FilterSelection): boolean {
  return (
    left.audience === right.audience &&
    left.scope === right.scope &&
    left.delivery === right.delivery
  )
}

function searchScopeLabel(
  signedIn: boolean,
  audience: ReturnType<typeof selectedAudience>,
): string {
  if (!signedIn) return 'Searching the User guide docs'
  return audience ? `Searching ${DOC_AUDIENCE_LABELS[audience]} docs` : 'Searching all docs'
}

function DocsViewControls({
  model,
  navigationItems,
  selectedItem,
  showProjectChooser,
  project,
  onProject,
  filters,
  onFilters,
  createAction,
  showDrafts,
  onShowDrafts,
  canShowDrafts,
  canShowWorking,
  showWorking,
  onShowWorking,
  doc,
  signedIn,
  onOpenFirst,
  onShowList,
  docActions,
}: {
  model: ReturnType<typeof docsViewModel>
  navigationItems: readonly Docs.DocsTreeItem[]
  selectedItem: Docs.DocsTreeItem | null
} & Pick<DocsControlsProps, 'onShowList' | 'docActions'> &
  Pick<
    DocsViewProps,
    | 'showProjectChooser'
    | 'project'
    | 'onProject'
    | 'filters'
    | 'onFilters'
    | 'createAction'
    | 'showDrafts'
    | 'onShowDrafts'
    | 'canShowDrafts'
    | 'showWorking'
    | 'onShowWorking'
    | 'canShowWorking'
    | 'doc'
    | 'signedIn'
    | 'onOpenFirst'
  >) {
  const selectProject = (next: string | 'all') => {
    onProject(next)
    if (!selectedItem || next === 'all' || selectedItem.projectName === next) return
    const first = docsViewModel(
      navigationItems,
      next,
      filters,
      null,
      doc,
      signedIn,
      showWorking,
    ).first
    if (first) onOpenFirst(first)
  }
  return (
    <DocsControls
      showProjectChooser={showProjectChooser}
      project={project}
      onProject={selectProject}
      subjects={model.subjects}
      offered={model.offered}
      chosen={model.stale}
      onFilters={onFilters}
      inView={model.inView}
      active={model.active}
      createAction={createAction}
      showDrafts={showDrafts}
      onShowDrafts={onShowDrafts}
      canShowDrafts={canShowDrafts}
      showWorking={showWorking}
      onShowWorking={onShowWorking}
      canShowWorking={canShowWorking && model.canShowWorking}
      onShowList={onShowList}
      docActions={docActions}
    />
  )
}

function useDocsNavigationModel(
  items: readonly Docs.DocsTreeItem[],
  showDrafts: boolean,
  selectedId: string | null,
  project: string | 'all',
  chosen: FilterSelection,
  doc: Docs.DocsDoc | null,
  signedIn: boolean,
  showWorking: boolean,
  onFilters: (filters: FilterSelection) => void,
) {
  const openedId = useRef<string | null>(null)
  const navigationItems = useMemo(() => docsVisibleByStatus(items, showDrafts), [items, showDrafts])
  const selectedItem = items.find((item) => item.id === selectedId) ?? null
  const model = docsViewModel(
    navigationItems,
    project,
    chosen,
    selectedId,
    doc,
    signedIn,
    showWorking,
  )
  useEffect(() => {
    if (!sameFilters(model.stale, chosen)) onFilters(model.stale)
  }, [model.stale, chosen, onFilters])
  useEffect(() => {
    if (!selectedId) {
      openedId.current = null
      return
    }
    if (openedId.current === selectedId) return
    openedId.current = selectedId
    const item = navigationItems.find((row) => row.id === selectedId)
    if (!item) return
    const next = filtersHiding(item, chosen)
    if (!sameFilters(next, chosen)) onFilters(next)
  }, [selectedId, navigationItems, chosen, onFilters])
  return { model, navigationItems, selectedItem }
}

function DocsSearchHost({
  open,
  onOpen,
  query,
  onQuery,
  results,
  tree,
  onSelect,
  signedIn,
  audience,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  query: string
  onQuery: (query: string) => void
  results: readonly Docs.DocsSearchMatch[]
  tree: readonly Docs.DocsTreeItem[]
  onSelect: (item: Docs.DocsTreeItem) => void
  signedIn: boolean
  audience: ReturnType<typeof selectedAudience>
}) {
  return (
    <SearchDialog
      open={open}
      onOpenChange={(next) => {
        onOpen(next)
        if (!next) onQuery('')
      }}
      query={query}
      onQueryChange={onQuery}
      results={results}
      tree={tree}
      onChoose={onSelect}
      scopeLabel={searchScopeLabel(signedIn, audience)}
    />
  )
}

function OptionalDocsFacts({
  wide,
  ...facts
}: { wide: boolean } & Parameters<typeof DocsFacts>[0]) {
  return wide ? null : <DocsFacts {...facts} />
}

/** The tree opens every folder above the selected document, so it is never hidden. */
function useExpandedToSelected(
  selectedId: string | null,
  tree: readonly Docs.TreeNode[],
  setCollapsed: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
) {
  useEffect(() => {
    if (!selectedId) return
    const ancestors = treePath(tree, selectedId).slice(0, -1)
    if (!ancestors.length) return
    setCollapsed((current) => {
      let changed = false
      const next = new Set(current)
      for (const ancestor of ancestors) {
        if (next.delete(ancestor.id)) changed = true
      }
      return changed ? next : current
    })
  }, [selectedId, tree, setCollapsed])
}

/**
 * On a phone the list is a drawer, open on arrival when no document was asked for. A linked
 * document resolves only once the docs are ready, so the arrival is judged then.
 */
function usePhoneDocsList(ready: boolean, selectedId: string | null) {
  const phone = useMediaQuery(PHONE_QUERY)
  const [listOpen, setListOpen] = useState(false)
  const arrived = useRef(false)
  useEffect(() => {
    if (!phone || !ready || arrived.current) return
    arrived.current = true
    if (!selectedId) setListOpen(true)
  }, [phone, ready, selectedId])
  // The drawer is a phone overlay; leaving the phone width closes it rather than keeping it.
  useEffect(() => {
    if (!phone) setListOpen(false)
  }, [phone])
  return {
    phone,
    /** What the page's controls add on a phone: the list cell and the document's actions. */
    controls: (headerAction: ReactNode) =>
      phone ? { onShowList: () => setListOpen(true), docActions: headerAction } : {},
    /** The reading pane keeps its own actions only on a desk. */
    readingAction: (headerAction: ReactNode) => (phone ? undefined : headerAction),
    /** The list beside the reading pane on a desk; in a drawer on a phone. */
    inGrid: (rail: ReactNode) => (phone ? null : rail),
    drawer: (rail: ReactNode) =>
      phone ? (
        <Drawer open={listOpen} onClose={() => setListOpen(false)} title="Documents">
          {rail}
        </Drawer>
      ) : null,
    closeList: () => setListOpen(false),
  }
}

export function DocsView({
  sourceLabel,
  items,
  selectedId,
  filters: chosen,
  onFilters,
  project,
  onProject,
  signedIn,
  showProjectChooser,
  showDrafts,
  onShowDrafts,
  canShowDrafts,
  canShowWorking,
  showWorking,
  onShowWorking,
  doc,
  replacement,
  locationFor,
  onSelect,
  onOpenFirst,
  ready,
  searchQuery,
  onSearchQuery,
  searchResults,
  framed,
  headerAction,
  createAction,
  loading,
  error,
  revisionId,
  onRevision = () => {},
  bodyView,
  viewedRevision,
  canManage,
  ...readingEdit
}: DocsViewProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [wide, setWide] = useState(false)
  const list = usePhoneDocsList(ready, selectedId)
  const { model, navigationItems, selectedItem } = useDocsNavigationModel(
    items,
    showDrafts,
    selectedId,
    project,
    chosen,
    doc,
    signedIn,
    showWorking,
    onFilters,
  )
  useExpandedToSelected(selectedId, model.tree, setCollapsed)
  useSearchHotkey(() => setSearchOpen(true))
  const detached = selectedItem !== null && treePath(model.tree, selectedItem.id).length === 0
  const readingCrumbs = detached ? breadcrumb(selectedItem, []) : model.crumbs
  const readingAround = detached ? { previous: null, next: null } : model.around
  const firstId = model.first?.id ?? null
  useEffect(() => {
    if (!ready || selectedId) return
    const first = navigationItems.find((item) => item.id === firstId)
    if (first) onOpenFirst(first)
  }, [ready, selectedId, firstId, navigationItems, onOpenFirst])
  const rail = (
    <DocsRail
      tree={model.tree}
      groups={model.groups}
      selectedId={selectedId}
      collapsed={collapsed}
      onToggle={(id) => setCollapsed((current) => toggled(current, id))}
      onSelect={(item) => {
        list.closeList()
        onSelect(item)
      }}
      onSearch={() => setSearchOpen(true)}
      loading={loading}
      emptyMessage={signedIn ? 'No docs here yet.' : 'No user docs here yet.'}
      treeReorder={readingEdit.treeReorder}
      inDrawer={list.phone}
    />
  )
  const controls = (
    <DocsViewControls
      {...list.controls(headerAction)}
      model={model}
      navigationItems={navigationItems}
      selectedItem={selectedItem}
      showProjectChooser={showProjectChooser}
      project={project}
      onProject={onProject}
      filters={chosen}
      onFilters={onFilters}
      createAction={createAction}
      showDrafts={showDrafts}
      onShowDrafts={onShowDrafts}
      canShowDrafts={canShowDrafts}
      canShowWorking={canShowWorking}
      showWorking={showWorking}
      onShowWorking={onShowWorking}
      doc={doc}
      signedIn={signedIn}
      onOpenFirst={onOpenFirst}
    />
  )
  return (
    <div
      className={classes(
        'flex flex-col',
        framed
          ? 'site-docs-chrome min-h-dvh bg-surface-sunken [--docs-top:var(--site-nav-h)] [--docs-stick:calc(var(--docs-top)+var(--docs-chrome-h))]'
          : 'min-h-[calc(100dvh-var(--topbar-h))] bg-surface-page [--docs-top:var(--topbar-h)] [--docs-stick:var(--docs-top)] md:-mt-6 -mx-4 -mb-8 md:-mx-8',
      )}
    >
      {framed ? (
        <DocsChrome controls={controls} />
      ) : (
        <div className="px-4 md:px-8">
          <PageHeader
            title="Docs"
            subtitle={`${model.documentCount} documents · ${sourceLabel}`}
            actions={controls}
          />
        </div>
      )}
      <div
        className={classes(
          'mx-auto grid min-h-0 w-full flex-1 grid-cols-1 lg:min-h-[calc(100dvh-var(--docs-stick))]',
          wide
            ? 'lg:grid-cols-[var(--docs-rail)_minmax(0,1fr)]'
            : 'max-w-(--docs-width) lg:grid-cols-[var(--docs-rail)_minmax(0,1fr)_var(--docs-rail)]',
        )}
      >
        {list.inGrid(rail)}
        <DocsReading
          doc={doc}
          tree={model.tree}
          signedIn={signedIn}
          audience={selectedAudience(model.stale)}
          pending={!doc && (Boolean(model.selected) || detached || !ready)}
          wide={wide}
          onWide={setWide}
          crumbs={readingCrumbs}
          around={readingAround}
          onSelect={onSelect}
          replacement={replacement}
          locationFor={locationFor}
          headerAction={list.readingAction(headerAction)}
          error={error}
          bodyView={bodyView}
          viewedRevision={viewedRevision}
          {...readingEdit}
        />
        <OptionalDocsFacts
          wide={wide}
          doc={doc}
          headings={doc ? model.headings : []}
          signedIn={signedIn}
          showHistory={readingEdit.showHistory}
          controls={readingEdit.factsControls}
          history={readingEdit.history}
          revisionId={revisionId}
          onRevision={onRevision}
          canManage={canManage}
        />
      </div>
      {list.drawer(rail)}
      <DocsSearchHost
        open={searchOpen}
        onOpen={setSearchOpen}
        query={searchQuery}
        onQuery={onSearchQuery}
        results={searchResults}
        tree={navigationItems}
        onSelect={onSelect}
        signedIn={signedIn}
        audience={selectedAudience(model.stale)}
      />
    </div>
  )
}
