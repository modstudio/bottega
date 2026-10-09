import { ChevronDown, ChevronRight } from 'lucide-react'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { classes } from '@/ui/text/classes'
import { DocStatusBadge } from './status-badge.tsx'
import type { DocsTreeGroup, DocsTreeItem, TreeNode } from './types.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

function TreeDocumentRow({
  node,
  item,
  current,
  rowRef,
  onSelect,
}: {
  node: TreeNode
  item: DocsTreeItem
  current: boolean
  rowRef: MutableRefObject<HTMLElement | null>
  onSelect: (item: DocsTreeItem) => void
}) {
  const ref = (element: HTMLElement | null) => {
    rowRef.current = element
  }
  if (node.navigationDisabled) {
    return (
      <span
        ref={ref}
        aria-current={current ? 'page' : undefined}
        aria-disabled="true"
        title={node.title}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left text-text-muted"
      >
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        <DocStatusBadge status={node.status} />
      </span>
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={() => onSelect(item)}
      title={node.title}
      className={classes(
        'flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left',
        current
          ? 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover'
          : 'text-text-secondary hover:bg-control-hover',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{node.title}</span>
      <DocStatusBadge status={node.status} />
    </button>
  )
}

function TreeRow({
  node,
  gutter,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  /** Reserve the toggle's width, so rows align in a list where some row can expand. */
  gutter: boolean
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
}) {
  const current = node.id === selectedId
  const open = !collapsed.has(node.id)
  const { children, ...item } = node
  const rowRef = useRef<HTMLElement>(null)
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
        ) : gutter ? (
          <span className="size-6 shrink-0" />
        ) : null}
        <TreeDocumentRow
          node={node}
          item={item}
          current={current}
          rowRef={rowRef}
          onSelect={onSelect}
        />
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

export function TreeList({
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
  const gutter = nodes.some((node) => node.children.length > 0)
  return (
    <ul className="m-0 list-none p-0 text-md">
      {nodes.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          gutter={gutter}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

export function GroupedTree({
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
