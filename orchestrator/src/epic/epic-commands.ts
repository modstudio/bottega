// concern: epic-commands
/** Owns epic scoreboard presentation. Must not know CLI grammar. */

import { projectAt } from '../project/projects.ts'
import { epicChildren, epicScoreboard, renderEpicHuman } from './epic.ts'

export async function epicCommand(
  key: string,
  json: boolean,
  presentation: { log(value: string): void },
): Promise<void> {
  const project = projectAt(process.cwd())
  if (!project) throw new Error('orch epic requires a registered project working directory')
  const report = epicScoreboard(key, await epicChildren(project.name, key))
  presentation.log(json ? JSON.stringify(report) : renderEpicHuman(report))
}
