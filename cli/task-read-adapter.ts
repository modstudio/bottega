import { Database } from 'bun:sqlite'
import {
  installProjectRegisterReader,
  projectRegisterReader,
} from '../hub/src/project-register-reader.ts'
import {
  type ConfinementProbeTaskInput,
  installConfinementProbeTaskCreator,
} from '../orchestrator/src/sandbox/confinement-probe-task-port.ts'
import {
  installTaskReader,
  type TaskReadPort,
} from '../orchestrator/src/workflow/task-read-port.ts'

type HubTaskReads = {
  task: typeof import('../hub/src/task.ts')
  document: typeof import('../hub/src/task-document.ts')
  projects: typeof import('../hub/src/projects.ts')
}

let loadedHubTaskReads: HubTaskReads | undefined

type ProjectRegisterReads = {
  migrations: typeof import('../orchestrator/src/database/migrations.ts')
  project: typeof import('../orchestrator/src/project/project-read.ts')
  presentation: typeof import('../orchestrator/src/project/project-list-json.ts')
  registration: typeof import('../orchestrator/src/project/project-registration.ts')
  contract: typeof import('../shared/orch-contract.ts')
}

let loadedProjectRegisterReads: ProjectRegisterReads | undefined

/** Load the register implementation on its first read and reuse it for this process. */
function projectRegisterReads(): ProjectRegisterReads {
  if (loadedProjectRegisterReads) return loadedProjectRegisterReads
  loadedProjectRegisterReads = {
    migrations:
      require('../orchestrator/src/database/migrations.ts') as typeof import('../orchestrator/src/database/migrations.ts'),
    project:
      require('../orchestrator/src/project/project-read.ts') as typeof import('../orchestrator/src/project/project-read.ts'),
    presentation:
      require('../orchestrator/src/project/project-list-json.ts') as typeof import('../orchestrator/src/project/project-list-json.ts'),
    registration:
      require('../orchestrator/src/project/project-registration.ts') as typeof import('../orchestrator/src/project/project-registration.ts'),
    contract: require('../shared/orch-contract.ts') as typeof import('../shared/orch-contract.ts'),
  }
  return loadedProjectRegisterReads
}

/** Load the hub implementation on the first task read and reuse it for this process. */
function hubTaskReads(): HubTaskReads {
  if (loadedHubTaskReads) return loadedHubTaskReads
  loadedHubTaskReads = {
    task: require('../hub/src/task.ts') as typeof import('../hub/src/task.ts'),
    document:
      require('../hub/src/task-document.ts') as typeof import('../hub/src/task-document.ts'),
    projects: require('../hub/src/projects.ts') as typeof import('../hub/src/projects.ts'),
  }
  return loadedHubTaskReads
}

function registerConfinementProbeProject(input: ConfinementProbeTaskInput) {
  const register = projectRegisterReads()
  const fixtureRegister = new Database(input.orchestratorDatabase, { create: true })
  try {
    fixtureRegister.exec('PRAGMA foreign_keys = ON;')
    register.migrations.applyMigrations(fixtureRegister)
    register.registration.registerLocalProject(input.project, null, fixtureRegister)
    return register.presentation.listedProjectJson(input.project)
  } finally {
    fixtureRegister.close()
  }
}

/** Build the CLI-owned port without loading its hub implementation. */
function cliTaskReadAdapter(): TaskReadPort {
  return {
    list(filters) {
      return hubTaskReads().task.listTasks(filters)
    },
    async duplicates(project, title) {
      const { duplicateCandidates, listTasks } = hubTaskReads().task
      return duplicateCandidates(await listTasks({ project }), title)
    },
    show(key, scope) {
      return hubTaskReads().task.showTask(key, scope)
    },
    async documents(key, scope) {
      return hubTaskReads().document.listTaskDocuments(key, scope)
    },
    async document(value, scope) {
      return hubTaskReads().document.getTaskDocument(value, scope)
    },
  }
}

/** Install the lazy CLI-owned adapter into the orchestrator process. */
export function installCliTaskReader(): void {
  loadedHubTaskReads = undefined
  loadedProjectRegisterReads = undefined
  installTaskReader(cliTaskReadAdapter())
  installProjectRegisterReader((options) => {
    const { project, presentation, contract } = projectRegisterReads()
    return contract.OrchProjectListSchema.parse(
      project.projects(options).map(presentation.listedProjectJson),
    )
  })
  installConfinementProbeTaskCreator((connection, input) => {
    const hub = hubTaskReads()
    const fixtureProject = registerConfinementProbeProject(input)
    const priorReader = projectRegisterReader()
    if (!priorReader) throw new Error('confinement probe needs the installed project reader')
    installProjectRegisterReader(() => [fixtureProject])
    hub.projects.refreshProjects()
    try {
      const task = hub.task.createLocalTaskInTransaction(
        connection,
        { project: fixtureProject.name, title: 'Verify confined CLI access' },
        { skipDuplicateCheck: true },
      )
      return {
        key: task.key,
        project: { name: fixtureProject.name, recordId: fixtureProject.record_id },
      }
    } finally {
      installProjectRegisterReader(priorReader)
      hub.projects.refreshProjects()
    }
  })
}
