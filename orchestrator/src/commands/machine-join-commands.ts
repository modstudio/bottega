// concern: machine join, approval, anchoring, and recovery command grammar

import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { hostedConfigClient } from '../config/hosted-config-call-outcome.ts'
import { machineApprove, machineJoin } from '../config/machine-join.ts'
import { machineAnchor, machineRecover } from '../config/trust-log-anchor.ts'
import { promptHidden } from './hidden-prompt.ts'
import { log } from './support.ts'

type SelectedSpace = { spaceId: string; slug: string }
type SelectSpace = (
  verb: string,
  requested: string | undefined,
  client: ConfigClient,
) => Promise<SelectedSpace>

const ttyPorts = () => ({
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
})

export function registerMachineJoinCommands(machine: Command, selectSpace: SelectSpace): void {
  machine
    .command('join')
    .description('print a pairing code and wait for an approved machine')
    .option('--space <slug>', 'join this record space')
    .action(async (options) => {
      const client = hostedConfigClient()
      const selected = await selectSpace('machine join', options.space, client)
      const approved = await machineJoin(selected, { client, env: process.env, output: log })
      log(`approved by ${approved.label} (${approved.keyId})`)
    })
  machine
    .command('approve <code...>')
    .description('approve a joining machine with its pairing code')
    .option('--space <slug>', 'approve in this record space')
    .action(async (code: string[], options) => {
      const client = hostedConfigClient()
      const selected = await selectSpace('machine approve', options.space, client)
      const approved = await machineApprove(code.join('-'), selected, {
        client,
        env: process.env,
        output: log,
      })
      log(`approved ${approved.label} (${approved.keyId})`)
    })
  machine
    .command('anchor')
    .description('anchor this record space machine trust log')
    .option('--space <slug>', 'anchor this record space')
    .action(async (options) => {
      const client = hostedConfigClient()
      const selected = await selectSpace('machine anchor', options.space, client)
      await machineAnchor(selected, {
        client,
        env: process.env,
        ...ttyPorts(),
        output: log,
        confirm: async () => {
          const terminal = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return (
              (
                await terminal.question(
                  'Type WRITTEN to confirm the recovery words are written down: ',
                )
              )
                .trim()
                .toLowerCase() === 'written'
            )
          } finally {
            terminal.close()
          }
        },
      })
    })
  machine
    .command('recover')
    .description('recover this machine into a record space machine trust log')
    .option('--space <slug>', 'recover into this record space')
    .action(async (options) => {
      const client = hostedConfigClient()
      const selected = await selectSpace('machine recover', options.space, client)
      await machineRecover(selected, {
        client,
        env: process.env,
        ...ttyPorts(),
        output: log,
        promptWords: () =>
          promptHidden(
            'Recovery words: ',
            'recovery words prompt ended before words were entered',
            process.stdin,
            process.stderr,
          ),
      })
    })
}
