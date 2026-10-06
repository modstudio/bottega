import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/ui/button/button'
import { Kbd } from '@/ui/kbd/kbd'
import { Select } from '@/ui/listbox/select'
import { Popover } from '@/ui/popover/popover'
import { Tabs } from '@/ui/tabs/tabs'
import { classes } from '@/ui/text/classes'
import { readingBody } from './body.ts'
import {
  EMPTY_FILTERS,
  type FilterKey,
  type FilterSelection,
  type OfferedFilter,
} from './filters.ts'
import type { DocHeading } from './headings.ts'
import { docsViewModel } from './model.ts'
import { SearchDialog } from './search.tsx'
import { treePath } from './tree.ts'
import type {
  DocsAudience,
  DocsDoc,
  DocsSearchMatch,
  DocsTreeGroup,
  DocsTreeItem,
  TreeNode,
} from './types.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

export type DocsViewProps = {
  items: readonly DocsTreeItem[]
  selectedId: string | null
  audience: DocsAudience
  onAudience: (audience: DocsAudience) => void
  project: string | 'all'
  onProject: (project: string | 'all') => void
  signedIn: boolean
  showProjectChooser: boolean
  doc: DocsDoc | null
  onSelect: (item: DocsTreeItem) => void
  searchQuery: string
  onSearchQuery: (query: string) => void
  searchResults: readonly DocsSearchMatch[]
  framed: boolean
  localActions?: ReactNode
  createAction?: ReactNode
  loading?: boolean
  error?: string | null
}

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function FilterOption({
  name,
  checked,
  label,
  count,
  onSelect,
}: {
  name: string
  checked: boolean
  label: string
  count: number
  onSelect: () => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-md text-text-secondary">
      <input className="sr-only" type="radio" name={name} checked={checked} onChange={onSelect} />
      <span
        aria-hidden
        className={classes(
          'size-3.5 shrink-0 rounded-full border-4',
          checked ? 'border-accent-fill bg-surface-page' : 'border-border-strong bg-surface-page',
        )}
      />
      <span>{label}</span>
      <span className="ml-auto font-mono text-text-muted text-xs">{count}</span>
    </label>
  )
}

function FilterPanel({
  offered,
  chosen,
  onChange,
  total,
}: {
  offered: OfferedFilter[]
  chosen: FilterSelection
  onChange: (next: FilterSelection) => void
  total: number
}) {
  const labels: Record<FilterKey, string> = { scope: 'Scope', delivery: 'Delivery' }
  const active = Boolean(chosen.scope || chosen.delivery)
  return (
    <div className="w-[min(17.5rem,calc(100vw-2.5rem))]">
      {offered.map((filter) => (
        <fieldset
          key={filter.key}
          className="m-0 border-0 border-border-default border-t p-0 pt-3 first:border-t-0 first:pt-0"
        >
          <legend className={classes(eyebrow, 'mb-1.5 px-0')}>{labels[filter.key]}</legend>
          <FilterOption
            name={`docs-filter-${filter.key}`}
            checked={chosen[filter.key] === null}
            label="Any"
            count={total}
            onSelect={() => onChange({ ...chosen, [filter.key]: null })}
          />
          {filter.options.map((option) => (
            <FilterOption
              key={option.value}
              name={`docs-filter-${filter.key}`}
              checked={chosen[filter.key] === option.value}
              label={option.value}
              count={option.count}
              onSelect={() => onChange({ ...chosen, [filter.key]: option.value })}
            />
          ))}
        </fieldset>
      ))}
      <div className="mt-3 flex justify-between border-border-default border-t pt-2.5 text-sm text-text-muted">
        <span>Only filters these docs can use</span>
        {active ? (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
}) {
  const current = node.id === selectedId
  const open = !collapsed.has(node.id)
  const { children, ...item } = node
  const rowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!current) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <li className="m-0">
      <div className="flex items-center">
        {children.length ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
            onClick={() => onToggle(node.id)}
            className="grid size-6 shrink-0 place-items-center text-text-muted"
          >
            {open ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
          </button>
        ) : (
          <span className="size-6 shrink-0" />
        )}
        <button
          ref={rowRef}
          type="button"
          aria-current={current ? 'page' : undefined}
          onClick={() => onSelect(item)}
          className={classes(
            'min-w-0 flex-1 rounded-sm px-2 py-1 text-left text-text-secondary hover:bg-control-hover',
            current && 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover',
          )}
        >
          {node.title}
        </button>
      </div>
      {children.length && open ? (
        <div className="ml-3 border-border-default border-l pl-1">
          <TreeList
            nodes={children}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        </div>
      ) : null}
    </li>
  )
}

function TreeList({
  nodes,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  nodes: readonly TreeNode[]
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
}) {
  return (
    <ul className="m-0 list-none p-0 text-md">
      {nodes.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

function GroupedTree({
  groups,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  groups: readonly DocsTreeGroup[]
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
}) {
  return (
    <div>
      {groups.map((group) => (
        <div key={group.heading} className="mt-2.5 first:mt-0">
          <div className={classes(eyebrow, 'px-2')}>{group.heading}</div>
          <TreeList
            nodes={group.children}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
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
}) {
  const tabs = [
    { value: 'user', label: 'User guide', count: userCount },
    ...(signedIn ? [{ value: 'technical', label: 'Technical', count: technicalCount }] : []),
  ]
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-border-default border-b px-5">
      <Tabs
        label="Audience"
        value={audience}
        onChange={(value) => onAudience(value === 'technical' ? 'technical' : 'user')}
        items={tabs}
      />
      <div className="flex flex-wrap items-center gap-3 py-2">
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
  return (
    <nav
      aria-label="Documents"
      className="max-h-[min(24rem,70dvh)] overflow-y-auto border-border-default border-b p-5 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-var(--topbar-h)-3.5rem)] lg:border-r lg:border-b-0"
    >
      <button
        type="button"
        onClick={onSearch}
        className="mb-4 flex w-full items-center justify-between text-left text-md text-text-muted"
      >
        <span>Search docs</span>
        <Kbd>/</Kbd>
      </button>
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
    </nav>
  )
}

function DocsReading({
  doc,
  crumbs,
  around,
  onSelect,
  localActions,
  error,
}: {
  doc: DocsDoc | null
  crumbs: readonly string[]
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
  localActions?: ReactNode
  error?: string | null
}) {
  return (
    <main className="min-w-0 bg-surface-page px-6 py-8 md:px-11 md:py-9">
      {error ? (
        <p data-tone="error" className="text-status-text">
          {error}
        </p>
      ) : null}
      {doc ? (
        <>
          {crumbs.length ? (
            <div className={classes(eyebrow, 'flex flex-wrap gap-2')}>
              {crumbs.map((crumb, index) => (
                <span key={`${index}:${crumb}`} className="contents">
                  {index > 0 ? <span>/</span> : null}
                  <span>{crumb}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
            <h1 className="font-normal font-serif text-3xl tracking-tight md:text-[2.625rem] md:leading-[1.06]">
              {doc.title}
            </h1>
            {localActions}
          </div>
          <div className="mt-6">
            <Markdown content={readingBody(doc.body)} />
          </div>
          <div className="mt-14 flex max-w-[68ch] justify-between gap-4 border-border-default border-t pt-4 text-md text-text-muted">
            {around.previous ? (
              <button
                type="button"
                className="text-left hover:text-text-primary"
                onClick={() => onSelect(around.previous!)}
              >
                ← {around.previous.title}
              </button>
            ) : (
              <span />
            )}
            {around.next ? (
              <button
                type="button"
                className="text-right hover:text-text-primary"
                onClick={() => onSelect(around.next!)}
              >
                {around.next.title} →
              </button>
            ) : (
              <span />
            )}
          </div>
        </>
      ) : (
        <p className="text-md text-text-muted">Select a document.</p>
      )}
    </main>
  )
}

function DocsFacts({
  doc,
  headings,
  signedIn,
}: {
  doc: DocsDoc | null
  headings: readonly DocHeading[]
  signedIn: boolean
}) {
  return (
    <aside className="hidden border-border-default border-l px-5 py-8 lg:block">
      {headings.length ? (
        <section>
          <span className={eyebrow}>On this page</span>
          <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0">
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className="text-md text-text-muted hover:text-text-primary"
                >
                  {heading.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {doc ? (
        <section className={headings.length ? 'mt-7' : undefined}>
          <span className={eyebrow}>About</span>
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md">
            <dt className="text-text-muted">Audience</dt>
            <dd className="m-0 text-text-secondary">
              {doc.audience === 'user' ? 'User' : 'Technical'}
            </dd>
            <dt className="text-text-muted">Updated</dt>
            <dd className="m-0 text-text-secondary">{updatedLabel(doc.updatedAt)}</dd>
            {signedIn ? (
              <>
                <dt className="text-text-muted">Address</dt>
                <dd className="m-0 min-w-0 break-words text-text-secondary">
                  {doc.scope} / {doc.subject ?? '—'} / {doc.slug}
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
    </aside>
  )
}

export function DocsView({
  items,
  selectedId,
  audience,
  onAudience,
  project,
  onProject,
  signedIn,
  showProjectChooser,
  doc,
  onSelect,
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
  const model = docsViewModel(items, audience, project, chosen, selectedId, doc)
  useEffect(() => {
    if (model.stale.scope !== chosen.scope || model.stale.delivery !== chosen.delivery) {
      setChosen(model.stale)
    }
  }, [model.stale, chosen])
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
  return (
    <div
      className={classes(
        'flex flex-col bg-surface-sunken',
        framed ? 'min-h-dvh' : 'min-h-[calc(100dvh-var(--topbar-h))] md:-mt-6 -mx-4 -mb-8 md:-mx-8',
      )}
    >
      <DocsChrome
        audience={audience}
        onAudience={onAudience}
        signedIn={signedIn}
        userCount={model.userCount}
        technicalCount={model.technicalCount}
        showProjectChooser={showProjectChooser}
        project={project}
        onProject={onProject}
        subjects={model.subjects}
        offered={model.offered}
        chosen={model.stale}
        onFilters={setChosen}
        inView={model.inView}
        active={model.active}
        createAction={createAction}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[16.75rem_minmax(0,1fr)_13.5rem]">
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
          doc={doc}
          crumbs={model.crumbs}
          around={model.around}
          onSelect={onSelect}
          localActions={localActions}
          error={error}
        />
        <DocsFacts doc={doc} headings={model.headings} signedIn={signedIn} />
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
        tree={items}
        onChoose={onSelect}
        scopeLabel={`Searching the ${audience === 'user' ? 'User guide' : 'Technical'} docs`}
      />
    </div>
  )
}
