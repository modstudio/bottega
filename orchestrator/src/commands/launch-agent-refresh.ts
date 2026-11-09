// concern: cli
/** Adapts the hidden launch-agent refresh verb to its service. */

import type { Command } from 'commander'
import { gatherLaunchAgentSkipFacts } from '../../../shared/launch-agent-skip.ts'
import { type MachineLevel, readMachineValue } from '../../../shared/machine-config.ts'
import { refreshLaunchAgents } from '../health/launch-agent-refresh.ts'
import { requiredMaintenanceLabels } from '../setup/setup-schedule-policy.ts'

export function registerLaunchAgentRefreshCommand(
  program: Command,
  presentation: { log(value: string): void },
): void {
  program
    .command('launch-agents', { hidden: true })
    .command('refresh')
    .allowExcessArguments(false)
    .action(() =>
      refreshLaunchAgents(process.platform, presentation, {
        requiredMaintenanceLabels: () =>
          requiredMaintenanceLabels(
            gatherLaunchAgentSkipFacts(),
            readMachineValue('machine.level') as MachineLevel,
          ),
      }),
    )
}
