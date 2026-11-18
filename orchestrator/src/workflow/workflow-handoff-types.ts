// concern: workflow handoff types
/** Shared output shapes for workflow composition and handoff rendering. */

export type CursorSummary = {
  id: number
  n: number
  slug: string
  state: 'running' | 'awaiting-ruling' | 'finishing' | 'done' | 'abandoned'
  opened: boolean
  previousSession?: string | null
}

export type GraduatedExplore = { cursor: number; closed: true }
