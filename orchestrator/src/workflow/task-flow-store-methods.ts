// concern: task-flow store method placement
/** Names synchronous reads that must remain available inside local transactions. */

export type TaskFlowWriteMethod =
  | 'write'
  | 'retireStageIdentity'
  | 'insertStage'
  | 'cacheAdoptedFlow'
  | 'relinkProjectReferences'
  | 'renameStageProject'

export const taskFlowLocalReadPlacement = {
  conflictingHostedStage: 'local-only',
  openStageForTask: 'shared',
  flowRecordIdForTask: 'local-only',
  flowProjectionForTask: 'shared',
  stageByRecordId: 'shared',
  stageRevision: 'local-only',
  waitingWorkflowQuestions: 'shared',
  questionOutboxRow: 'local-only',
  unlinkedWorkflowQuestionIds: 'local-only',
} as const

export type TaskFlowLocalReadMethod = keyof typeof taskFlowLocalReadPlacement
export type TaskFlowLocalOnlyReadMethod = {
  [K in TaskFlowLocalReadMethod]: (typeof taskFlowLocalReadPlacement)[K] extends 'local-only'
    ? K
    : never
}[TaskFlowLocalReadMethod]
