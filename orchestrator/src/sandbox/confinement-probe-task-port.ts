// concern: confinement probe task creation port; the CLI composition root supplies the hub adapter.

import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'

export type ConfinementProbeTaskInput = {
  orchestratorDatabase: string
  project: Project
}

export type ConfinementProbeTask = {
  id: string
  key: string
  project: { name: string; recordId: string }
}

type ConfinementProbeTaskCreator = (
  connection: Database,
  input: ConfinementProbeTaskInput,
) => ConfinementProbeTask

let installedCreator: ConfinementProbeTaskCreator | undefined

/** Install the hub-owned task creator at the CLI composition boundary. */
export function installConfinementProbeTaskCreator(creator: ConfinementProbeTaskCreator): void {
  installedCreator = creator
}

/** Create the probe task through the installed hub service. */
export function createConfinementProbeTask(
  connection: Database,
  input: ConfinementProbeTaskInput,
): ConfinementProbeTask {
  if (!installedCreator)
    throw new Error('confinement probe task creator is not installed by the CLI composition root')
  return installedCreator(connection, input)
}

export function confinementProbeProject(
  recordId: string,
  name: string,
  path: string,
  secretPaths: string[] = [],
  keyPrefixes: string[] = [],
): Project {
  return {
    recordId,
    name,
    path,
    stack: 'probe',
    canon: false,
    retiredAt: null,
    settings: { keyPrefixes, secretPaths },
  }
}

/** Adapt the hub-local probe task to the ask broker's narrow in-process fixture ports. */
export function probeWorkerRecordDependencies(input: {
  task: ConfinementProbeTask
  project: Project
  runId: string
  token: string
  spaceId: string
}) {
  const { task, project } = input
  const detail = {
    task: {
      id: task.id,
      key: task.key,
      project: project.name,
      project_name: project.name,
      projectId: project.recordId,
      project_id: project.recordId,
      title: 'Verify confined CLI access',
      status: 'active',
      status_category: 'active',
      parent_key: null,
      parent_id: null,
      body: 'fixture body',
      assignee: null,
      opened_at: null,
      closed_at: null,
      source: 'local',
      first_seen: '2026-11-23T00:00:00.000Z',
      last_seen: '2026-11-23T00:00:00.000Z',
      created_at: '2026-11-23T00:00:00.000Z',
      updated_at: '2026-11-23T00:00:00.000Z',
      deleted_at: null,
      next_document_number: 1,
      retired_reason: null,
      revision: 1,
    },
    comments: [],
    documents: [],
  }
  return {
    workerRecordClient: {
      task: async (identity: string) => {
        if (identity !== task.id && identity.toUpperCase() !== task.key.toUpperCase())
          throw new Error(`no fixture task ${identity}`)
        return detail
      },
      workflowText: async () => null,
      workflowStage: async () => null,
    },
    workerRecordScopeFacts: (runId: string, token: string) => ({
      authenticated: runId === input.runId && token === input.token,
      runStatus: 'running',
      runTaskId: task.id,
      runTaskKey: task.key,
      runProjectId: project.recordId,
      runSpaceId: input.spaceId,
      allowedTaskIds: [task.id],
      allowedTaskKeys: [task.key],
      project: project.name,
      keepsOwnTracker: false,
    }),
  }
}

export function probeTaskReadCommands(
  task: ConfinementProbeTask,
  cliArgv: string[],
  platformSlug: string,
) {
  const separator = task.key.lastIndexOf('-')
  const number = Number(task.key.slice(separator + 1))
  const outOfScopeKey = `${task.key.slice(0, separator + 1)}${number + 1}`
  return {
    own: {
      argv: [...cliArgv, 'task', 'show', task.key],
      label: `${platformSlug} task show <probe task>`,
    },
    refused: {
      argv: [...cliArgv, 'task', 'show', outOfScopeKey],
      label: `${platformSlug} task show <out-of-scope task>`,
    },
  }
}
