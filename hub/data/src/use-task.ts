import { useMutation, useQuery } from '@tanstack/react-query'
import { queryClient, type TaskRecordResponse, trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'

type Refusal = { allowed: true } | { allowed: false; reason: string }

const refusal = (capability: Refusal | undefined) =>
  capability && !capability.allowed ? capability.reason : undefined

const isTaskBodyConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'data' in error &&
  (error as { data?: { code?: string } }).data?.code === 'CONFLICT'

function useCommentActions(
  localInput: { key: string; scope: { recordId?: string } },
  refused: string | undefined,
  refresh: () => Promise<unknown>,
) {
  const comment = useMutation(trpc.work.comment.mutationOptions())
  const editComment = useMutation(trpc.work.editComment.mutationOptions())
  const deleteComment = useMutation(trpc.work.deleteComment.mutationOptions())
  return {
    comment: {
      run: async (body: string) => {
        if (refused) return
        await comment.mutateAsync({ ...localInput, body })
        await refresh()
      },
      pending: comment.isPending,
      error: comment.error,
      refused,
    },
    editComment: {
      run: async ({ id, body }: { id: string; body: string }) => {
        if (refused) return
        await editComment.mutateAsync({ ...localInput, commentId: id, body })
        await refresh()
      },
      pending: editComment.isPending,
      error: editComment.error,
      refused,
    },
    deleteComment: {
      run: async ({ id }: { id: string }) => {
        if (refused) return
        await deleteComment.mutateAsync({ ...localInput, commentId: id })
        await refresh()
      },
      pending: deleteComment.isPending,
      error: deleteComment.error,
      refused,
    },
  }
}

export function useTask(key: string, recordId?: string) {
  const hostedMode = isHostedMode()
  const separator = key.indexOf(':')
  const spaceId = separator > 0 ? key.slice(0, separator) : undefined
  const taskKey = separator > 0 ? key.slice(separator + 1) : key
  const localInput = { key: taskKey, scope: recordId ? { recordId } : {} }
  const hostedInput = { key: taskKey, spaceId }
  const local = useQuery({ ...trpc.work.task.queryOptions(localInput), enabled: !hostedMode })
  const hosted = useQuery({ ...trpc.record.task.queryOptions(hostedInput), enabled: hostedMode })
  const query = hostedMode ? hosted : local
  const detail = (query.data ?? null) as TaskRecordResponse | null

  const setTitle = useMutation(trpc.work.setTitle.mutationOptions())
  const setStatus = useMutation(trpc.work.setStatus.mutationOptions())
  const setBody = useMutation(trpc.work.setBody.mutationOptions())
  const setDocument = useMutation(trpc.work.setDocument.mutationOptions())
  const refresh = () => queryClient.invalidateQueries()
  const capability = detail?.capabilities
  const commentActions = useCommentActions(localInput, refusal(capability?.comment), refresh)

  return {
    detail,
    error: query.error,
    actions: {
      setTitle: {
        run: async (title: string) => {
          if (refusal(capability?.setTitle)) return
          await setTitle.mutateAsync({ ...localInput, title })
          await refresh()
        },
        pending: setTitle.isPending,
        error: setTitle.error,
        refused: refusal(capability?.setTitle),
      },
      setStatus: {
        run: async (status: 'open' | 'active' | 'review' | 'done' | 'dropped') => {
          if (refusal(capability?.setStatus)) return
          await setStatus.mutateAsync({ ...localInput, status })
          await refresh()
        },
        pending: setStatus.isPending,
        error: setStatus.error,
        refused: refusal(capability?.setStatus),
      },
      setBody: {
        /** Whether the body was saved; a refusal or failure leaves its reason on the action. */
        run: async (body: string): Promise<boolean> => {
          if (!detail || refusal(capability?.setBody)) return false
          try {
            await setBody.mutateAsync({
              ...localInput,
              body,
              expectedVersion: detail.bodyVersion,
            })
            await refresh()
            return true
          } catch {
            return false
          }
        },
        pending: setBody.isPending,
        error: setBody.error,
        refused: refusal(capability?.setBody),
        conflict: isTaskBodyConflict(setBody.error),
        async reload() {
          await (hostedMode
            ? queryClient.fetchQuery({
                ...trpc.record.task.queryOptions(hostedInput),
                staleTime: 0,
              })
            : queryClient.fetchQuery({
                ...trpc.work.task.queryOptions(localInput),
                staleTime: 0,
              }))
          await refresh()
          setBody.reset()
        },
      },
      ...commentActions,
      setDocument: {
        run: async (input: { id: string; title: string; body: string; version: string }) => {
          if (refusal(capability?.documents)) return
          await setDocument.mutateAsync(input)
          await refresh()
        },
        pending: setDocument.isPending,
        error: setDocument.error,
        refused: refusal(capability?.documents),
      },
    },
  }
}

export type UseTaskResult = ReturnType<typeof useTask>
