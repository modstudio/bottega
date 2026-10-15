import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { classes } from '@/ui/text/classes'
import { siblingKey, treePath } from './tree.ts'
import type { DocsTreeGroup, DocsTreeItem, TreeNode } from './types.ts'

const eyebrow = 'font-mono text-text-muted text-xs tracking-[0.14em] uppercase'

const siblingCollision: CollisionDetection = (input) => {
  const activeKey = input.active.data.current?.siblingKey
  return closestCenter({
    ...input,
    droppableContainers: input.droppableContainers.filter(
      (container) => container.data.current?.siblingKey === activeKey,
    ),
  })
}

function TreeDocumentRow({
  node,
  item,
  current,
  ancestor,
  rowRef,
  onSelect,
}: {
  node: TreeNode
  item: DocsTreeItem
  current: boolean
  /** The open article sits somewhere beneath this row. */
  ancestor: boolean
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
        className={classes(
          'min-w-0 flex-1 rounded-sm px-2 py-1 text-left',
          ancestor ? 'font-medium text-text-primary' : 'text-text-secondary',
        )}
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
          : ancestor
            ? 'font-medium text-text-primary hover:bg-control-hover'
            : 'text-text-secondary hover:bg-control-hover',
      )}
    >
      <span className="line-clamp-2 text-pretty">{node.title}</span>
    </button>
  )
}

function TreeRow({
  node,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  canReorder,
  onReorder,
}: {
  node: TreeNode
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
  canReorder?: (item: DocsTreeItem) => boolean
  onReorder?: (activeId: string, overId: string) => void
}) {
  const current = node.id === selectedId
  const ancestor = !current && selectedId !== null && treePath(node.children, selectedId).length > 0
  const open = !collapsed.has(node.id)
  const { children, ...item } = node
  const rowRef = useRef<HTMLElement>(null)
  const reorderable = Boolean(canReorder?.(item))
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
    disabled: !reorderable,
    data: { siblingKey: siblingKey(item) },
  })
  useEffect(() => {
    if (!current) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <li
      ref={setNodeRef}
      className="m-0"
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
          : undefined,
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <div className="group flex items-start">
        {reorderable ? (
          <button
            type="button"
            aria-label={`Reorder ${node.title}`}
            className="grid size-7 shrink-0 touch-none cursor-grab place-items-center rounded-sm text-text-muted opacity-0 hover:bg-control-hover hover:text-text-primary focus:opacity-100 focus-visible:outline-2 focus-visible:outline-focus-ring group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" aria-hidden />
          </button>
        ) : null}
        <TreeDocumentRow
          node={node}
          item={item}
          current={current}
          ancestor={ancestor}
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
        // An open level draws a rule beneath the start of its row's title, with a gap before its children.
        <div className="my-1 ml-2 border-border-default border-l pl-2">
          <TreeList
            nodes={children}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
            canReorder={canReorder}
            onReorder={onReorder}
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
  canReorder,
  onReorder,
}: {
  nodes: readonly TreeNode[]
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
  canReorder?: (item: DocsTreeItem) => boolean
  onReorder?: (activeId: string, overId: string) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={siblingCollision}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up document ${String(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `Document ${String(active.id)} is over ${String(over.id)}.` : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? `Dropped document ${String(active.id)} at ${String(over.id)}.`
              : 'Document was dropped.',
          onDragCancel: ({ active }) => `Cancelled dragging document ${String(active.id)}.`,
        },
      }}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder?.(String(active.id), String(over.id))
      }}
    >
      <SortableContext items={nodes.map((node) => node.id)} strategy={verticalListSortingStrategy}>
        <ul className="m-0 list-none p-0 text-md">
          {nodes.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              canReorder={canReorder}
              onReorder={onReorder}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

export function GroupedTree({
  groups,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  canReorder,
  onReorder,
}: {
  groups: readonly DocsTreeGroup[]
  selectedId: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (item: DocsTreeItem) => void
  canReorder?: (item: DocsTreeItem) => boolean
  onReorder?: (activeId: string, overId: string) => void
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
            canReorder={canReorder}
            onReorder={onReorder}
          />
        </div>
      ))}
    </div>
  )
}
