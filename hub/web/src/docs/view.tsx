import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/ui/button/button'
import { Kbd } from '@/ui/kbd/kbd'
import { Select } from '@/ui/listbox/select'
import { PageHeader } from '@/ui/page-header/page-header'
import { Popover } from '@/ui/popover/popover'
import { Switch } from '@/ui/switch/switch'
import { Tabs } from '@/ui/tabs/tabs'
import { classes } from '@/ui/text/classes'
import { FilterPanel } from './filter-panel.tsx'
import { EMPTY_FILTERS, type FilterSelection, type OfferedFilter } from './filters.ts'
import type { DocsLocation } from './location.ts'
import { docsSelectionInView, docsViewModel, docsVisibleByStatus } from './model.ts'
import { DocsFacts, DocsReading } from './reading.tsx'
import { SearchDialog } from './search.tsx'
import { breadcrumb, treePath } from './tree.ts'
import { GroupedTree, TreeList } from './tree-view.tsx'
import type {
  DocsAudience,
  DocsDoc,
  DocsSearchMatch,
  DocsTreeGroup,
  DocsTreeItem,
  TreeNode,
} from './types.ts'
import { useHeldPanel } from './use-held-panel.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

export type DocsViewProps = {
  sourceLabel: string
  /** The complete catalogue, including documents omitted from navigation. */
  items: readonly DocsTreeItem[]
  selectedId: string | null
  audience: DocsAudience
  onAudience: (audience: DocsAudience) => void
  project: string | 'all'
  onProject: (project: string | 'all') => void
  signedIn: boolean
  showProjectChooser: boolean
  showDrafts: boolean
  onShowDrafts: (show: boolean) => void
  canShowDrafts: boolean
  doc: DocsDoc | null
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  onSelect: (item: DocsTreeItem) => void
  /** Opens a document the reader did not pick, replacing the current history entry. */
  onOpenFirst: (item: DocsTreeItem) => void
  onLeaveTree: () => void
  /** True once the tree and the project chooser have settled. */
  ready: boolean
  searchQuery: string
  onSearchQuery: (query: string) => void
  searchResults: readonly DocsSearchMatch[]
  framed: boolean
  localActions?: ReactNode
  createAction?: ReactNode
  loading?: boolean
  error?: string | null
}

function DocsChrome({
  audience,
  onAudience,
  signedIn,
  userCount,
  technicalCount,
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
}: {
  audience: DocsAudience
  onAudience: (audience: DocsAudience) => void
  signedIn: boolean
  userCount: number
  technicalCount: number
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
}) {
  const showDraftsId = useId()
  const tabs = [
    { value: 'user', label: 'User guide', count: userCount },
    ...(signedIn ? [{ value: 'technical', label: 'Technical', count: technicalCount }] : []),
  ]
  return (
    <div className="docs-chrome-rule relative z-20 bg-inherit lg:sticky lg:top-(--docs-top)">
      <div className="mx-auto flex w-full min-h-(--docs-chrome-h) max-w-(--docs-width) flex-wrap items-end justify-between gap-3 px-5">
        {/* The tab list's own rule lies on the chrome's, so the selected marker sits on that line. */}
        <div className="relative z-10">
          <Tabs
            label="Audience"
            value={audience}
            onChange={(value) => onAudience(value === 'technical' ? 'technical' : 'user')}
            items={tabs}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 py-2">
          {canShowDrafts ? (
            <label
              htmlFor={showDraftsId}
              className="flex items-center gap-2 text-md text-text-secondary"
            >
              <Switch
                id={showDraftsId}
                aria-label="Show drafts"
                checked={showDrafts}
                onChange={(event) => onShowDrafts(event.currentTarget.checked)}
              />
              Show drafts
            </label>
          ) : null}
          {showProjectChooser ? (
            <div className="flex items-center gap-2">
              <span className={eyebrow}>Project</span>
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
          {offered.length ? (
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
              <FilterPanel offered={offered} chosen={chosen} onChange={onFilters} total={inView} />
            </Popover>
          ) : null}
          {createAction}
        </div>
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
  audience,
}: {
  tree: readonly TreeNode[]
  groups: readonly DocsTreeGroup[] | null
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
  onSearch: () => void
  loading?: boolean
  audience: DocsAudience
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
          <p className="mt-4 text-md text-text-muted">
            {audience === 'user' ? 'No user docs here yet.' : 'No technical docs here yet.'}
          </p>
        )}
      </div>
    </nav>
  )
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

function filtersHiding(item: DocsTreeItem, chosen: FilterSelection): FilterSelection {
  const next = { ...chosen }
  if (next.scope && next.scope !== item.scope) next.scope = null
  if (next.delivery && next.delivery !== item.delivery) next.delivery = null
  return next
}

export function DocsView({
  sourceLabel,
  items,
  selectedId,
  audience,
  onAudience,
  project,
  onProject,
  signedIn,
  showProjectChooser,
  showDrafts,
  onShowDrafts,
  canShowDrafts,
  doc,
  replacement,
  locationFor,
  onSelect,
  onOpenFirst,
  onLeaveTree,
  ready,
  searchQuery,
  onSearchQuery,
  searchResults,
  framed,
  localActions,
  createAction,
  loading,
  error,
}: DocsViewProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [chosen, setChosen] = useState<FilterSelection>(EMPTY_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [wide, setWide] = useState(false)
  const openedId = useRef<string | null>(null)
  const navigationItems = useMemo(() => docsVisibleByStatus(items, showDrafts), [items, showDrafts])
  const selectedItem = items.find((item) => item.id === selectedId) ?? null
  const model = docsViewModel(navigationItems, audience, project, chosen, selectedId, doc)
  useEffect(() => {
    if (model.stale.scope !== chosen.scope || model.stale.delivery !== chosen.delivery) {
      setChosen(model.stale)
    }
  }, [model.stale, chosen])
  useEffect(() => {
    if (!selectedId) {
      openedId.current = null
      return
    }
    if (openedId.current === selectedId) return
    openedId.current = selectedId
    const item = navigationItems.find((row) => row.id === selectedId)
    if (!item) return
    setChosen((current) => {
      const next = filtersHiding(item, current)
      if (next.scope === current.scope && next.delivery === current.delivery) return current
      return next
    })
  }, [selectedId, navigationItems])
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
    selectedItem !== null && !navigationItems.some((item) => item.id === selectedItem.id)
  const visible = model.selected || detached ? doc : null
  const readingCrumbs = detached ? breadcrumb(selectedItem, []) : model.crumbs
  const readingAround = detached ? { previous: null, next: null } : model.around
  // With nothing open, the page shows the first document in view instead of an empty pane.
  const firstId = model.first?.id ?? null
  const tabChosen = useRef(false)
  const technicalOnly = audience === 'user' && signedIn && !firstId && model.technicalCount > 0
  useEffect(() => {
    if (!ready || selectedId) return
    // An empty User guide beside a populated Technical tab opens on Technical, until the
    // reader picks a tab themselves.
    if (technicalOnly && !tabChosen.current) {
      onAudience('technical')
      return
    }
    const first = navigationItems.find((item) => item.id === firstId)
    if (first) onOpenFirst(first)
  }, [ready, selectedId, firstId, technicalOnly, navigationItems, onOpenFirst, onAudience])
  const leaveIfGone = (
    nextAudience: DocsAudience,
    nextProject: string | 'all',
    nextFilters: FilterSelection,
  ) => {
    if (!selectedId) return
    const selected = docsSelectionInView(items, nextAudience, nextProject, nextFilters, selectedId)
    if (selected) return
    const next = docsViewModel(
      navigationItems,
      nextAudience,
      nextProject,
      nextFilters,
      selectedId,
      doc,
    )
    if (next.first) onOpenFirst(next.first)
    else onLeaveTree()
  }
  return (
    <div
      className={classes(
        'flex flex-col',
        // The public page sits on the site's ground; inside the app every surface is the page's own.
        framed
          ? 'site-docs-chrome min-h-dvh bg-surface-sunken [--docs-top:var(--site-nav-h)] [--docs-stick:calc(var(--docs-top)+var(--docs-chrome-h))]'
          : 'min-h-[calc(100dvh-var(--topbar-h))] bg-surface-page [--docs-top:var(--topbar-h)] [--docs-stick:calc(var(--docs-top)+var(--docs-chrome-h))] md:-mt-6 -mx-4 -mb-8 md:-mx-8',
      )}
    >
      <div className="px-4 md:px-8">
        <PageHeader
          title="Docs"
          subtitle={`${model.userCount + model.technicalCount} documents · ${sourceLabel}`}
          actions={createAction}
        />
      </div>
      <DocsChrome
        audience={audience}
        onAudience={(next) => {
          tabChosen.current = true
          onAudience(next)
          leaveIfGone(next, project, chosen)
        }}
        signedIn={signedIn}
        userCount={model.userCount}
        technicalCount={model.technicalCount}
        showProjectChooser={showProjectChooser}
        project={project}
        onProject={(next) => {
          onProject(next)
          leaveIfGone(audience, next, chosen)
        }}
        subjects={model.subjects}
        offered={model.offered}
        chosen={model.stale}
        onFilters={(next) => {
          setChosen(next)
          leaveIfGone(audience, project, next)
        }}
        inView={model.inView}
        active={model.active}
        createAction={framed ? createAction : null}
        showDrafts={showDrafts}
        onShowDrafts={onShowDrafts}
        canShowDrafts={canShowDrafts}
      />
      <div
        className={classes(
          'mx-auto grid min-h-0 w-full flex-1 grid-cols-1 lg:min-h-[calc(100dvh-var(--docs-stick))]',
          wide
            ? 'lg:grid-cols-[16.75rem_minmax(0,1fr)]'
            : 'max-w-(--docs-width) lg:grid-cols-[16.75rem_minmax(0,1fr)_13.5rem]',
        )}
      >
        <DocsRail
          tree={model.tree}
          groups={model.groups}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={(id) =>
            setCollapsed((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelect={onSelect}
          onSearch={() => setSearchOpen(true)}
          loading={loading}
          audience={audience}
        />
        <DocsReading
          doc={visible}
          pending={!visible && (Boolean(model.selected) || detached || !ready)}
          wide={wide}
          onWide={setWide}
          crumbs={readingCrumbs}
          around={readingAround}
          onSelect={onSelect}
          replacement={replacement}
          locationFor={locationFor}
          localActions={localActions}
          error={error}
        />
        {wide ? null : (
          <DocsFacts doc={visible} headings={visible ? model.headings : []} signedIn={signedIn} />
        )}
      </div>
      <SearchDialog
        open={searchOpen}
        onOpenChange={(open) => {
          setSearchOpen(open)
          if (!open) onSearchQuery('')
        }}
        query={searchQuery}
        onQueryChange={onSearchQuery}
        results={searchResults}
        tree={navigationItems}
        onChoose={onSelect}
        scopeLabel={`Searching the ${audience === 'user' ? 'User guide' : 'Technical'} docs`}
      />
    </div>
  )
}
