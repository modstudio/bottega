import { useMutation } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { queryClient, trpc } from '@/trpc/client'
import { toast } from '@bottega/hub-ui/toast'
import type { DocScope } from '../../../../shared/docs.ts'
import { canEditDoc } from './edit-permission.ts'
import { orderedIdsAfterDrag, siblingKey } from './tree.ts'
import type { DocsSource, DocsTreeItem } from './types.ts'
import { useDocsTree } from './use-docs.ts'

export function useReorderableDocsTree(
  source: DocsSource,
  memberships: readonly Record<string, unknown>[] | undefined,
) {
  const catalog = useDocsTree(source)
  const [orders, setOrders] = useState<ReadonlyMap<string, readonly string[]>>(new Map())
  const local = useMutation(trpc.doc.reorder.mutationOptions())
  const hosted = useMutation(trpc.record.reorderDocs.mutationOptions())
  const items = useMemo(() => {
    if (!orders.size) return catalog.items
    return catalog.items.map((item) => {
      const position = orders.get(siblingKey(item))?.indexOf(item.id) ?? -1
      return position < 0 ? item : { ...item, position }
    })
  }, [catalog.items, orders])
  const canReorder = useCallback(
    (item: DocsTreeItem) =>
      !local.isPending &&
      !hosted.isPending &&
      item.kind === 'article' &&
      canEditDoc(source, memberships, item.spaceId),
    [hosted.isPending, local.isPending, memberships, source],
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
        toast.error(error instanceof Error ? error.message : 'Could not save the document order')
      } finally {
        setOrders((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
    },
    [canReorder, hosted, items, local, source],
  )
  return { ...catalog, items, treeReorder: { canReorder, onReorder } }
}
