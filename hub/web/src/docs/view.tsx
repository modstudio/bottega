import { type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/ui/button/button'
import { Kbd } from '@/ui/kbd/kbd'
import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'
import { Popover } from '@/ui/popover/popover'
import { classes } from '@/ui/text/classes'
import { DocsFacts } from './facts.tsx'
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
import { useHeldPanel } from './use-held-panel.ts'

export type DocsViewProps = {
  sourceLabel: string
  source: Docs.DocsSource
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
  showWorking: boolean
  onShowWorking: (show: boolean) => void
  doc: Docs.DocsDoc | null
  replacement: Docs.DocsTreeItem | null
  locationFor: (item: Docs.DocsTreeItem) => DocsLocation
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
  toolbar?: ReactNode
  banner?: ReactNode
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  canManage?: boolean
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
}

/** The project chooser, the filter panel and the create action: one group, wherever the page puts it. */
function DocsControls({
  showProjectChooser,
  project,
  onProject,
  subjects,
  offered,
  chosen,
  onFilters,
  inView,
  active,
  createAction,
  showDrafts,
  onShowDrafts,
  canShowDrafts,
  showWorking,
  onShowWorking,
  canShowWorking,
}: DocsControlsProps) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {showProjectChooser ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-text-muted text-xs tracking-[0.14em] uppercase">
            Project
          </span>
          <Select
            label="Project"
            size="sm"
            value={project}
            onChange={(value) => onProject(value === 'all' ? 'all' : value)}
            options={[
              ...subjects.map((name) => ({ value: name, label: name })),
              { value: 'all', label: 'All projects' },
            ]}
          />
        </div>
      ) : null}
      {offered.length || canShowDrafts || canShowWorking ? (
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
          <FilterPanel
            offered={offered}
            chosen={chosen}
            onChange={onFilters}
            total={inView}
            drafts={canShowDrafts ? { shown: showDrafts, onChange: onShowDrafts } : null}
            working={canShowWorking ? { shown: showWorking, onChange: onShowWorking } : null}
          />
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
}) {
  const hasTree = groups ? groups.length > 0 : tree.length > 0
  const panel = useRef<HTMLElement>(null)
  useHeldPanel(panel)
  return (
    <nav
      ref={panel}
      aria-label="Documents"
      className="flex max-h-[min(24rem,70dvh)] flex-col border-border-default border-b p-5 lg:sticky lg:top-(--docs-stick) lg:max-h-[calc(100dvh-var(--docs-stick))] lg:self-start lg:border-b-0"
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
            />
          ) : (
            <TreeList
              nodes={tree}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
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
  showWorking,
  onShowWorking,
  source,
  doc,
  signedIn,
  onOpenFirst,
}: {
  model: ReturnType<typeof docsViewModel>
  navigationItems: readonly Docs.DocsTreeItem[]
  selectedItem: Docs.DocsTreeItem | null
} & Pick<
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
  | 'source'
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
      canShowWorking={source !== 'public' && model.canShowWorking}
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

export function DocsView({
  sourceLabel,
  source,
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
  useEffect(() => {
    if (!selectedId) return
    const ancestors = treePath(model.tree, selectedId).slice(0, -1)
    if (!ancestors.length) return
    setCollapsed((current) => {
      let changed = false
      const next = new Set(current)
      for (const ancestor of ancestors) {
        if (next.delete(ancestor.id)) changed = true
      }
      return changed ? next : current
    })
  }, [selectedId, model.tree])
  useSearchHotkey(() => setSearchOpen(true))
  const detached =
    selectedItem !== null &&
    !model.tree.some(function contains(item): boolean {
      return item.id === selectedItem.id || item.children.some(contains)
    })
  const visible = doc
  const readingCrumbs = detached ? breadcrumb(selectedItem, []) : model.crumbs
  const readingAround = detached ? { previous: null, next: null } : model.around
  const firstId = model.first?.id ?? null
  useEffect(() => {
    if (!ready || selectedId) return
    const first = navigationItems.find((item) => item.id === firstId)
    if (first) onOpenFirst(first)
  }, [ready, selectedId, firstId, navigationItems, onOpenFirst])
  const controls = (
    <DocsViewControls
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
      showWorking={showWorking}
      onShowWorking={onShowWorking}
      source={source}
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
        <DocsRail
          tree={model.tree}
          groups={model.groups}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={(id) => setCollapsed((current) => toggled(current, id))}
          onSelect={onSelect}
          onSearch={() => setSearchOpen(true)}
          loading={loading}
          emptyMessage={signedIn ? 'No docs here yet.' : 'No user docs here yet.'}
        />
        <DocsReading
          doc={visible}
          signedIn={signedIn}
          audience={selectedAudience(model.stale)}
          pending={!visible && (Boolean(model.selected) || detached || !ready)}
          wide={wide}
          onWide={setWide}
          crumbs={readingCrumbs}
          around={readingAround}
          onSelect={onSelect}
          replacement={replacement}
          locationFor={locationFor}
          headerAction={headerAction}
          error={error}
          bodyView={bodyView}
          viewedRevision={viewedRevision}
          fieldSource={canManage && visible ? source : undefined}
          {...readingEdit}
        />
        {wide ? null : (
          <DocsFacts
            doc={visible}
            headings={visible ? model.headings : []}
            signedIn={signedIn}
            source={source}
            audience={selectedAudience(model.stale)}
            revisionId={revisionId}
            onRevision={onRevision}
            canManage={canManage}
          />
        )}
      </div>
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
