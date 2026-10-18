import { useTask } from '@bottega/hub-data/use-task'
import { useNavigate } from '@tanstack/react-router'
import { TaskScreen } from '@/components/task-screen'

/** A task route's search: which stored task a key names, and which of its documents is open. */
export function taskSearch(search: Record<string, unknown>): { id?: string; doc?: string } {
  return {
    id: typeof search.id === 'string' ? search.id : undefined,
    doc: typeof search.doc === 'string' ? search.doc : undefined,
  }
}

/** A task opened over one of the collections; closing returns to it. */
export function TaskRoute({
  taskKey,
  id,
  doc,
  list,
}: {
  taskKey: string
  id?: string
  doc?: string
  list: '/board' | '/flight' | '/done'
}) {
  const navigate = useNavigate()
  const result = useTask(taskKey, id)
  return (
    <TaskScreen
      taskKey={taskKey}
      result={result}
      openDoc={doc ?? null}
      onOpenDoc={(next) =>
        void navigate({
          to: `${list}/tasks/$key`,
          params: { key: taskKey },
          search: { id, doc: next ?? undefined },
          resetScroll: false,
        })
      }
      onClose={() => void navigate({ to: list, resetScroll: false })}
    />
  )
}
