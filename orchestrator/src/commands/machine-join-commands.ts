// concern: machine join, approval, anchoring, and recovery command grammar

import type { Command } from 'commander'
import type { ConfigClient } from '../../../shared/config-client.ts'
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
      const [{ hostedConfigClient }, { machineJoin }] = await Promise.all([
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/machine-join.ts'),
      ])
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
      const [{ hostedConfigClient }, join] = await Promise.all([
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/machine-join.ts'),
      ])
      const client = hostedConfigClient()
      const selected = await selectSpace('machine approve', options.space, client)
      const approved = await join.machineApprove(code.join('-'), selected, {
        client,
        env: process.env,
        output: log,
      })
      log(`approved ${approved.label} (${approved.keyId})`)
      if (!approved.anchored) log(join.unanchoredApprovalNotice(selected.slug))
    })
  machine
    .command('anchor')
    .description('anchor this record space machine trust log')
    .option('--space <slug>', 'anchor this record space')
    .action(async (options) => {
      const [{ createInterface }, { hostedConfigClient }, anchor] = await Promise.all([
        import('node:readline/promises'),
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/trust-log-anchor.ts'),
      ])
      const client = hostedConfigClient()
      const selected = await selectSpace('machine anchor', options.space, client)
      await anchor.machineAnchor(selected, {
        client,
        env: process.env,
        ...ttyPorts(),
        output: log,
        confirm: async () => {
          const terminal = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return anchor.recoveryWordsConfirmed(
              await terminal.question(anchor.RECOVERY_WORDS_CONFIRMATION_PROMPT),
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
      const [{ hostedConfigClient }, { machineRecover }, { promptHidden }] = await Promise.all([
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/trust-log-anchor.ts'),
        import('./hidden-prompt.ts'),
      ])
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
