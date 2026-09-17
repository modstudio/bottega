import { createFileRoute } from '@tanstack/react-router'
import { BoardView } from '@/components/work-view'

export const Route = createFileRoute('/board')({
  component: () => (
    <>
      <BoardView />
    </>
  ),
})
