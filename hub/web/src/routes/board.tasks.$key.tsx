import { useTask } from '@bottega/hub-data/use-task'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskScreen } from '@/components/task-screen'
import { taskSearch } from './-task-sheet-data'

export const Route = createFileRoute('/board/tasks/$key')({
  validateSearch: taskSearch,
  component: BoardTask,
})

function BoardTask() {
  const { key } = Route.useParams()
  const { id, doc } = Route.useSearch()
  const navigate = useNavigate()
  const result = useTask(key, id)
  return (
    <TaskScreen
      taskKey={key}
      result={result}
      openDoc={doc ?? null}
      onOpenDoc={(next) =>
        void navigate({
          to: '/board/tasks/$key',
          params: { key },
          search: { id, doc: next ?? undefined },
          resetScroll: false,
        })
      }
      onClose={() => void navigate({ to: '/board', resetScroll: false })}
    />
  )
}
