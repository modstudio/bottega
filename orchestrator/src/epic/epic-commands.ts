// concern: epic-commands
/** Owns epic scoreboard presentation. Must not know CLI grammar. */

import type { SubscriptionCostContext } from '../run/run-subscription-cost.ts'
import { epicChildren, epicScoreboard, renderEpicHuman } from './epic.ts'

export async function epicCommand(
  project: string,
  key: string,
  json: boolean,
  presentation: { log(value: string): void },
  options: { subscriptionCost?: SubscriptionCostContext } = {},
): Promise<void> {
  const report = epicScoreboard(key, await epicChildren(project, key), undefined, undefined, options)
  presentation.log(json ? JSON.stringify(report) : renderEpicHuman(report))
}
