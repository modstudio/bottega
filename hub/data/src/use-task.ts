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

type TaskMutation<Input> = {
  mutateAsync: (input: Input) => Promise<unknown>
  isPending: boolean
  error: { message: string } | null
}

/**
 * The task page saves its title and description as one draft. The body goes first because it
 * carries the version check, so a conflict writes nothing; the title follows only once it lands.
 */
function draftAction(
  detail: TaskRecordResponse | null,
  localInput: { key: string; scope: { recordId?: string } },
  setTitle: TaskMutation<{ key: string; scope: { recordId?: string }; title: string }>,
  setBody: TaskMutation<{
    key: string
    scope: { recordId?: string }
    body: string
    expectedVersion: string
  }>,
  capability: TaskRecordResponse['capabilities'] | undefined,
  refresh: () => Promise<unknown>,
) {
  const titleRefused = refusal(capability?.setTitle)
  const bodyRefused = refusal(capability?.setBody)
  return {
    run: async (draft: { title: string; body: string }): Promise<boolean> => {
      if (!detail) return false
      const title = draft.title.trim()
      try {
        if (draft.body !== (detail.task.body ?? '') && !bodyRefused)
          await setBody.mutateAsync({
            ...localInput,
            body: draft.body,
            expectedVersion: detail.bodyVersion,
          })
        if (title !== (detail.task.title ?? '').trim() && !titleRefused)
          await setTitle.mutateAsync({ ...localInput, title })
      } catch {
        return false
      } finally {
        await refresh()
      }
      return true
    },
    pending: setTitle.isPending || setBody.isPending,
    error: setBody.error ?? setTitle.error,
    refused: titleRefused && bodyRefused ? bodyRefused : undefined,
    conflict: isTaskBodyConflict(setBody.error),
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
        /** Fetches the stored task afresh and returns it, so a draft can restart from it. */
        async reload(): Promise<TaskRecordResponse> {
          const fresh = (await (hostedMode
            ? queryClient.fetchQuery({
                ...trpc.record.task.queryOptions(hostedInput),
                staleTime: 0,
              })
            : queryClient.fetchQuery({
                ...trpc.work.task.queryOptions(localInput),
                staleTime: 0,
              }))) as TaskRecordResponse
          await refresh()
          setBody.reset()
          return fresh
        },
      },
      ...commentActions,
      saveDraft: draftAction(detail, localInput, setTitle, setBody, capability, refresh),
    },
  }
}

export type UseTaskResult = ReturnType<typeof useTask>
