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
  conflictingHostedStage: 'shared',
  openStageForTask: 'shared',
  flowRecordIdForTask: 'shared',
  flowProjectionForTask: 'shared',
  stageByRecordId: 'shared',
  stageRevision: 'shared',
  waitingWorkflowQuestions: 'shared',
  unlinkedWorkflowQuestionIds: 'shared',
} as const

export type TaskFlowLocalReadMethod = keyof typeof taskFlowLocalReadPlacement
export type TaskFlowLocalOnlyReadMethod = {
  [K in TaskFlowLocalReadMethod]: (typeof taskFlowLocalReadPlacement)[K] extends 'local-only'
    ? K
    : never
}[TaskFlowLocalReadMethod]
