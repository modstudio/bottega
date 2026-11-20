// concern: confinement probe task creation port; the CLI composition root supplies the hub adapter.

import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'

export type ConfinementProbeTaskInput = {
  orchestratorDatabase: string
  project: Project
}

export type ConfinementProbeTask = {
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
