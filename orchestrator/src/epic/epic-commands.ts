// concern: epic-commands
/** Owns epic scoreboard presentation. Must not know CLI grammar. */

import {
  type EpicScoreboardOptions,
  epicChildren,
  epicScoreboard,
  renderEpicHuman,
} from './epic.ts'

export async function epicCommand(
  project: string,
  key: string,
  json: boolean,
  presentation: { log(value: string): void },
  options: EpicScoreboardOptions = {},
): Promise<void> {
  const report = epicScoreboard(
    key,
    await epicChildren(project, key),
    undefined,
    undefined,
    options,
  )
  presentation.log(json ? JSON.stringify(report) : renderEpicHuman(report))
}
