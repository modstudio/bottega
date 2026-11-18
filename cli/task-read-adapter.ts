import type { TaskReadPort } from '../orchestrator/src/workflow/task-read-port.ts'

/** Load the hub implementation only for an orchestrator entry and build its task reader. */
export async function cliTaskReadAdapter(): Promise<TaskReadPort> {
  const [{ listTasks, showTask }, { listTaskDocuments, getTaskDocument }] = await Promise.all([
    import('../hub/src/task.ts'),
    import('../hub/src/task-document.ts'),
  ])
  return {
    list: listTasks,
    show: showTask,
    documents: listTaskDocuments,
    document: getTaskDocument,
  }
}
