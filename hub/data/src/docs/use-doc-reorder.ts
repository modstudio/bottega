import { useMutation } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import type { DocScope } from '../../../../shared/docs.ts'
import { queryClient, trpc } from '../client.ts'
import { type DataTreeItem, type DocsSource, useDocsTree } from './use-docs.ts'

export function useReorderableDocsTree<T extends DataTreeItem & { kind: string; position: number }>(
  source: DocsSource,
  memberships: readonly Record<string, unknown>[] | undefined,
  mapTreeItem: (row: Record<string, unknown>) => T,
  canEditDoc: (
    source: DocsSource,
    memberships: readonly Record<string, unknown>[] | undefined,
    spaceId?: string,
  ) => boolean,
  siblingKey: (item: T) => string,
  orderedIdsAfterDrag: (items: readonly T[], activeId: string, overId: string) => string[],
) {
  const catalog = useDocsTree(source, mapTreeItem)
  const [orders, setOrders] = useState<ReadonlyMap<string, readonly string[]>>(new Map())
  const [error, setError] = useState<unknown>(null)
  const local = useMutation(trpc.doc.reorder.mutationOptions())
  const hosted = useMutation(trpc.record.reorderDocs.mutationOptions())
  const items = useMemo(() => {
    if (!orders.size) return catalog.items
    return catalog.items.map((item) => {
      const position = orders.get(siblingKey(item))?.indexOf(item.id) ?? -1
      return position < 0 ? item : { ...item, position }
    })
  }, [catalog.items, orders, siblingKey])
  const canReorder = useCallback(
    (item: T) =>
      !local.isPending &&
      !hosted.isPending &&
      item.kind === 'article' &&
      canEditDoc(source, memberships, item.spaceId),
    [hosted.isPending, local.isPending, memberships, source, canEditDoc],
  )
  const onReorder = useCallback(
    async (activeId: string, overId: string) => {
      const active = items.find((item) => item.id === activeId)
      const over = items.find((item) => item.id === overId)
      if (!active || !over || !canReorder(active) || siblingKey(active) !== siblingKey(over)) return
      const orderedIds = orderedIdsAfterDrag(
        items.filter((item) => siblingKey(item) === siblingKey(active)),
        activeId,
        overId,
      )
      const key = siblingKey(active)
      setOrders((current) => new Map(current).set(key, orderedIds))
      try {
        setError(null)
        const order = {
          scope: active.scope as DocScope,
          subject: active.subject,
          parentId: active.parentId,
          orderedIds,
        }
        if (source === 'hosted' && active.spaceId)
          await hosted.mutateAsync({ ...order, spaceId: active.spaceId })
        else await local.mutateAsync(order)
        await queryClient.invalidateQueries()
      } catch (error) {
        setError(error)
      } finally {
        setOrders((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
    },
    [canReorder, hosted, items, local, source, orderedIdsAfterDrag, siblingKey],
  )
  return { ...catalog, reorderError: error, items, treeReorder: { canReorder, onReorder } }
}
