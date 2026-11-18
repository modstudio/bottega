// concern: workflow task-flow stage insertion
/** Builds the common stage-insert shape used by compose and handoff intents. */

import type { TaskFlowIntentInput } from './task-flow-store-types.ts'

type StageInsert = TaskFlowIntentInput<'compose'>['stageInsert']

export function workflowStageInsert(input: {
  id: string
  flowRecordId: string
  projectId: string
  workflow: string
  mode: string
  workflowKey: string
  instanceId: string
  sessionId: string | null
  workflowVersionId: string
  catalogueVersionId: string
  arguments: Record<string, string>
  activeSlug: string
  autonomy: string | null
  totalSteps: number
  openedMachineId: string
  handedOffFromRecordId?: string
  createdAt: string
}): StageInsert {
  return {
    ...input,
    activeOrdinal: 0,
    activeSlug: input.activeSlug,
    state: 'running',
    closedStepNotes: [],
    question: null,
    enforcement: 'floors',
    takenOverFromMachineId: null,
    lastAdvancedMachineId: input.openedMachineId,
    updatedAt: input.createdAt,
  }
}
