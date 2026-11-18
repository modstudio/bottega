// concern: workflow handoff types
/** Shared output shapes for workflow composition and handoff rendering. */
import type { CursorState } from './workflow-cursor-transition.ts'

export type CursorSummary = {
  id: number
  n: number
  slug: string
  state: CursorState
  opened: boolean
  previousSession?: string | null
}

export type GraduatedExplore =
  | { cursor: number; closed: true }
  | { cursor: number; closed: false; reason: string }
