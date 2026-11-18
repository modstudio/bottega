import {
  installTaskReader,
  type TaskReadPort,
} from '../orchestrator/src/workflow/task-read-port.ts'

type HubTaskReads = {
  task: typeof import('../hub/src/task.ts')
  document: typeof import('../hub/src/task-document.ts')
}

let loadedHubTaskReads: HubTaskReads | undefined

/** Load the hub implementation on the first task read and reuse it for this process. */
function hubTaskReads(): HubTaskReads {
  if (loadedHubTaskReads) return loadedHubTaskReads
  loadedHubTaskReads = {
    task: require('../hub/src/task.ts') as typeof import('../hub/src/task.ts'),
    document:
      require('../hub/src/task-document.ts') as typeof import('../hub/src/task-document.ts'),
  }
  return loadedHubTaskReads
}

/** Build the CLI-owned port without loading its hub implementation. */
function cliTaskReadAdapter(): TaskReadPort {
  return {
    list(filters) {
      return hubTaskReads().task.listTasks(filters)
    },
    show(key, scope) {
      return hubTaskReads().task.showTask(key, scope)
    },
    documents(key, scope) {
      return hubTaskReads().document.listTaskDocuments(key, scope)
    },
    document(value, scope) {
      return hubTaskReads().document.getTaskDocument(value, scope)
    },
  }
}

/** Install the lazy CLI-owned adapter into the orchestrator process. */
export function installCliTaskReader(): void {
  installTaskReader(cliTaskReadAdapter())
}
