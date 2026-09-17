// concern: epic-commands
/** Owns epic scoreboard presentation. Must not know CLI grammar. */
import { epicChildren, epicScoreboard, renderEpicHuman } from './epic.ts'

export async function epicCommand(
  key: string,
  json: boolean,
  presentation: { log(value: string): void },
): Promise<void> {
  const report = epicScoreboard(key, await epicChildren(key))
  presentation.log(json ? JSON.stringify(report) : renderEpicHuman(report))
}
