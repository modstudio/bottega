// concern: config-commands
/** Owns only the `orch config` grammar and presentation. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { type ConfigScope, configClient } from '../../../shared/config-client.ts'
import {
  deleteSecret,
  machineInit,
  machineRevoke,
  machineShow,
  machineTrust,
  setSecret,
} from '../config/config-service.ts'
import { log } from './support.ts'

const scope = (options: { space?: boolean }): ConfigScope => (options.space ? 'space' : 'user')

export function register(program: Command): void {
  const config = program.command('config')
  const machine = config.command('machine')
  machine
    .command('init')
    .option('--label <label>')
    .action(async (options) => log(await machineInit(options.label)))
  machine.command('show').action(async () => {
    const shown = await machineShow()
    log(`${shown.keyId}\t${shown.publicKey}`)
  })
  machine
    .command('trust <keyId> <publicKey>')
    .option('--label <label>')
    .option('--yes')
    .action(async (keyId, publicKey, options) => {
      const label = options.label ?? keyId
      if (!options.yes) {
        if (!process.stdin.isTTY)
          throw new Error('machine trust requires an interactive terminal or --yes')
        process.stderr.write(`Trust machine ${label} with key id ${keyId}\n`)
        const terminal = createInterface({ input: process.stdin, output: process.stderr })
        const answer = await terminal.question('Type the full key id to confirm: ')
        terminal.close()
        if (answer.trim() !== keyId)
          throw new Error('machine trust confirmation did not match the key id')
      }
      await machineTrust(keyId, publicKey, label)
      log(keyId)
    })
  machine.command('revoke <keyId>').action(async (keyId) => {
    const rows = await machineRevoke(keyId)
    log(
      `revoked ${keyId}; re-sealed ${rows.length} row(s)${rows.length ? `: ${rows.join(', ')}` : ''}`,
    )
  })

  config
    .command('get <key>')
    .option('--space')
    .action(async (key, options) => {
      const row = await configClient().getEntry(key, scope(options), 'default')
      log(row.value)
    })
  config
    .command('set <key> <value>')
    .option('--space')
    .action(async (key, value, options) => {
      const client = configClient()
      const target = scope(options)
      let version: number | null = null
      try {
        version = (await client.getEntry(key, target, 'default')).rowVersion
      } catch (error) {
        if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error
      }
      await client.putEntry(key, {
        scope: target,
        environment: 'default',
        value,
        expectedRowVersion: version,
      })
    })
  config.command('list').action(async () => {
    for (const row of await configClient().listEntries('default'))
      log(`${row.scope}\t${row.key}\t${row.value}`)
  })
  config
    .command('delete <key>')
    .option('--space')
    .action(async (key, options) => {
      const client = configClient()
      const target = scope(options)
      const row = await client.getEntry(key, target, 'default')
      await client.deleteEntry(key, {
        scope: target,
        environment: 'default',
        expectedRowVersion: row.rowVersion,
      })
    })

  const secret = config.command('secret')
  secret
    .command('set <key>')
    .option('--space')
    .action(async (key, options) => {
      if (process.stdin.isTTY) throw new Error('secret value must be provided on stdin')
      const value = await Bun.stdin.text()
      await setSecret(key, value.replace(/\r?\n$/, ''), scope(options))
    })
  secret.command('list').action(async () => {
    for (const row of await configClient().listSecrets('default'))
      log(`${row.scope}\t${row.key}\t${row.updatedAt}`)
  })
  secret
    .command('delete <key>')
    .option('--space')
    .action(async (key, options) => {
      await deleteSecret(key, scope(options))
    })
}
