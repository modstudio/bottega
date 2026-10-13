import { ChevronDown, ChevronRight } from 'lucide-react'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { classes } from '@/ui/text/classes'
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
        className="min-w-0 flex-1 rounded-sm px-2 py-1 text-left text-text-secondary"
      >
        <span className="line-clamp-2 text-pretty">{node.title}</span>
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
        'min-w-0 flex-1 rounded-sm px-2 py-1 text-left',
        current
          ? 'bg-accent-fill text-accent-on-fill hover:bg-accent-fill-hover'
          : 'text-text-secondary hover:bg-control-hover',
      )}
    >
      <span className="line-clamp-2 text-pretty">{node.title}</span>
    </button>
  )
}

function TreeRow({
  node,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  /** How far below the top of the tree this row sits; the top level is zero. */
  depth: number
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
      <div className="flex items-start">
        <TreeDocumentRow
          node={node}
          item={item}
          current={current}
          rowRef={rowRef}
          onSelect={onSelect}
        />
        {children.length ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
            onClick={() => onToggle(node.id)}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-text-muted hover:bg-control-hover hover:text-text-primary"
          >
            {open ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      {children.length && open ? (
        // The top level indents without a rule; a rule marks nesting only from the second level down.
        <div className={depth === 0 ? 'pl-3' : 'ml-2 border-border-default border-l pl-2'}>
          <TreeList
            nodes={children}
            depth={depth + 1}
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
  depth = 0,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  nodes: readonly TreeNode[]
  depth?: number
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
          depth={depth}
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
