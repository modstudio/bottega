import { useTask } from '@bottega/hub-data/use-task'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskScreen } from '@/components/task-screen'
import { taskSearch } from './-task-sheet-data'

export const Route = createFileRoute('/done/tasks/$key')({
  validateSearch: taskSearch,
  component: DoneTask,
})

function DoneTask() {
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
          to: '/done/tasks/$key',
          params: { key },
          search: { id, doc: next ?? undefined },
          resetScroll: false,
        })
      }
      onClose={() => void navigate({ to: '/done', resetScroll: false })}
    />
  )
}
