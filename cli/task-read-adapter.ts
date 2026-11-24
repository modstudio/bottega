import { tmpdir } from 'node:os'
import {
  installProjectRegisterReader,
  projectRegisterReader,
} from '../hub/src/project-register-reader.ts'
import type { lookupTasks as lookupTaskRows } from '../hub/src/task.ts'
import {
  type ConfinementProbeTaskInput,
  installConfinementProbeTaskCreator,
} from '../orchestrator/src/sandbox/confinement-probe-task-port.ts'
import {
  installTaskReader,
  type TaskReadPort,
} from '../orchestrator/src/workflow/task-read-port.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'
import {
  realPathForPotentialPath,
  temporaryStateStoreMigrationAllowed,
} from '../shared/state-directory.ts'

type HubTaskReads = {
  db: typeof import('../hub/src/db.ts')
  task: typeof import('../hub/src/task.ts') & { lookupTasks: typeof lookupTaskRows }
  taskLocalRead: typeof import('../hub/src/task-local-read.ts')
  document: typeof import('../hub/src/task-document.ts')
  projects: typeof import('../hub/src/projects.ts')
}

let loadedHubTaskReads: HubTaskReads | undefined

type ProjectRegisterReads = {
  database: typeof import('../orchestrator/src/database/db.ts')
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
    database:
      require('../orchestrator/src/database/db.ts') as typeof import('../orchestrator/src/database/db.ts'),
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
    db: require('../hub/src/db.ts') as typeof import('../hub/src/db.ts'),
    task: require('../hub/src/task.ts') as typeof import('../hub/src/task.ts'),
    taskLocalRead:
      require('../hub/src/task-local-read.ts') as typeof import('../hub/src/task-local-read.ts'),
    document:
      require('../hub/src/task-document.ts') as typeof import('../hub/src/task-document.ts'),
    projects: require('../hub/src/projects.ts') as typeof import('../hub/src/projects.ts'),
  }
  return loadedHubTaskReads
}

function registerConfinementProbeProject(input: ConfinementProbeTaskInput) {
  const register = projectRegisterReads()
  const storePath = realPathForPotentialPath(input.orchestratorDatabase)
  const temporaryDirectory = realPathForPotentialPath(tmpdir())
  if (!temporaryStateStoreMigrationAllowed(storePath, temporaryDirectory)) {
    throw new Error(
      renderRefusal(
        refusal(
          `refusing to create the confinement probe store outside OS temporary state: ${input.orchestratorDatabase}\n` +
            'invariant: A confinement probe creates and migrates only its isolated temporary store.',
          {
            kind: 'edit',
            text: 'run the confinement report with its fixture state under the OS temporary directory',
          },
        ),
      ),
    )
  }
  register.database.createDatabasePrivately(input.orchestratorDatabase, (database) => {
    register.migrations.applyMigrations(database)
    register.registration.registerLocalProject(input.project, null, database)
  })
  return register.presentation.listedProjectJson(input.project)
}

/** Build the CLI-owned port without loading its hub implementation. */
function cliTaskReadAdapter(): TaskReadPort {
  return {
    list(filters) {
      return hubTaskReads().task.listTasks(filters)
    },
    listLocal(filters) {
      return Promise.resolve(hubTaskReads().taskLocalRead.listLocalTasks(filters))
    },
    lookup(project, keys) {
      return hubTaskReads().task.lookupTasks(project, keys)
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

/** Install the lazy in-process project register reader for a CLI entry. */
export function installCliProjectRegisterReader(): void {
  loadedProjectRegisterReads = undefined
  installProjectRegisterReader((options) => {
    const { database, project, presentation, contract } = projectRegisterReads()
    return database.withReadOnlyDatabaseAccess(() =>
      contract.OrchProjectListSchema.parse(
        project.projects(options).map(presentation.listedProjectJson),
      ),
    )
  })
}

/** Install the lazy CLI-owned adapter into the orchestrator process. */
export function installCliTaskReader(): void {
  loadedHubTaskReads = undefined
  installTaskReader(cliTaskReadAdapter())
  installCliProjectRegisterReader()
  installConfinementProbeTaskCreator((connection, input) => {
    const hub = hubTaskReads()
    const fixtureProject = registerConfinementProbeProject(input)
    const priorReader = projectRegisterReader()
    if (!priorReader) throw new Error('confinement probe needs the installed project reader')
    installProjectRegisterReader(() => [fixtureProject])
    hub.projects.refreshProjects()
    try {
      const task = hub.db.writeTransaction(
        (fixtureConnection) =>
          hub.task.createLocalTaskInTransaction(
            fixtureConnection,
            { project: fixtureProject.name, title: 'Verify confined CLI access' },
            { skipDuplicateCheck: true },
          ),
        connection,
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
