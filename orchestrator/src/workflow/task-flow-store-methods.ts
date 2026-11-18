// concern: task-flow store method placement
/** Names synchronous reads that must remain available inside local transactions. */

export type TaskFlowWriteMethod =
  | 'write'
  | 'retireStageIdentity'
  | 'cacheAdoptedFlow'
  | 'relinkProjectReferences'
  | 'renameStageProject'

export const taskFlowLocalReadMethods = [
  'openStageForTask',
  'flowProjectionForTask',
  'stageByRecordId',
  'waitingWorkflowQuestions',
] as const

export type TaskFlowLocalReadMethod = (typeof taskFlowLocalReadMethods)[number]
