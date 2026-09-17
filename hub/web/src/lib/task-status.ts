import {
  Circle,
  CircleCheck,
  CircleDotDashed,
  CircleEllipsis,
  CircleSlash,
  type LucideIcon,
} from 'lucide-react'
import type { Tone } from '@/ui/badge/badge'

type TaskStatusLook = { tone: Tone; icon: LucideIcon }

const openLook: TaskStatusLook = { tone: 'neutral', icon: Circle }

const looks: Record<string, TaskStatusLook> = {
  open: openLook,
  active: { tone: 'progress', icon: CircleDotDashed },
  review: { tone: 'info', icon: CircleEllipsis },
  done: { tone: 'success', icon: CircleCheck },
  dropped: { tone: 'neutral', icon: CircleSlash },
}

/** How a task's hub status category is drawn: work in motion reads as progress. */
export function taskStatusLook(category: string): TaskStatusLook {
  return looks[category] ?? openLook
}
