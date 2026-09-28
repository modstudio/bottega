// concern: config-commands
/** Owns only the `orch config` grammar and presentation. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import type { ConfigScope } from '../../../shared/config-client.ts'
import {
  isReleaseAutonomyValue,
  RELEASE_AUTONOMY_VALUES,
} from '../../../shared/release-autonomy.ts'
import {
  deleteEntry,
  deleteSecret,
  getEntry,
  listEntries,
  listSecrets,
  machineInit,
  machineRevoke,
  machineShow,
  machineTrust,
  setEntry,
  setSecret,
} from '../config/config-service.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { log } from './support.ts'

const scope = (options: { space?: boolean }): ConfigScope => (options.space ? 'space' : 'user')
type ConfigRow = Awaited<ReturnType<typeof getEntry>>

export function assertConfigWriteAllowed(
  key: string,
  value: string,
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): void {
  if (key.startsWith('autonomy.') && isOrchWorkerProcess(env, pid, inventory)) {
    throw new Error(
      `refusing autonomy config write from an orch worker run; an operator must run orch config set ${key} ${value}`,
    )
  }
  if (key === 'autonomy.release' && !isReleaseAutonomyValue(value))
    throw new Error(
      `invalid autonomy.release; expected one of ${RELEASE_AUTONOMY_VALUES.join(', ')}`,
    )
}

export const configGetPresentation = (row: ConfigRow, json: boolean) =>
  json ? JSON.stringify(row) : row.value
export const configListPresentation = (rows: ConfigRow[], json: boolean) =>
  json ? [JSON.stringify(rows)] : rows.map((row) => `${row.scope}\t${row.key}\t${row.value}`)

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
    .option('--json')
    .action(async (key, options) => {
      const row = await getEntry(key, scope(options))
      log(configGetPresentation(row, Boolean(options.json)))
    })
  config
    .command('set <key> <value>')
    .option('--space')
    .option('--json')
    .action(async (key, value, options) => {
      assertConfigWriteAllowed(key, value)
      const row = await setEntry(key, value, scope(options))
      if (options.json) log(configGetPresentation(row, true))
    })
  config
    .command('list')
    .option('--json')
    .action(async (options) => {
      const rows = await listEntries()
      for (const line of configListPresentation(rows, Boolean(options.json))) log(line)
    })
  config
    .command('delete <key>')
    .option('--space')
    .action(async (key, options) => {
      await deleteEntry(key, scope(options))
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
    for (const row of await listSecrets()) log(`${row.scope}\t${row.key}\t${row.updatedAt}`)
  })
  secret
    .command('delete <key>')
    .option('--space')
    .action(async (key, options) => {
      await deleteSecret(key, scope(options))
    })
}
