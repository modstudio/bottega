// concern: cli
/** Adapts the hidden launch-agent refresh verb to its service. */

import type { Command } from 'commander'
import { refreshLaunchAgents } from '../health/launch-agent-refresh.ts'

export function registerLaunchAgentRefreshCommand(
  program: Command,
  presentation: { log(value: string): void },
): void {
  program
    .command('launch-agents', { hidden: true })
    .command('refresh')
    .allowExcessArguments(false)
    .action(() => refreshLaunchAgents(process.platform, presentation))
}
