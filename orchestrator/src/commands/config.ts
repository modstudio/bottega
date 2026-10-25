// concern: config-commands
/** Owns only the `bottega machine config` grammar and presentation. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigScope } from '../../../shared/config-client.ts'
import {
  isShipToConfigKey,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  storedShipToLevel,
} from '../../../shared/ship-to.ts'
import {
  deleteEntry,
  deleteMachineEntry,
  deleteSecret,
  getEntry,
  listEntries,
  listMachineEntries,
  listSecrets,
  machineInit,
  machineRevoke,
  machineShow,
  machineTrust,
  sealSecretDecision,
  setEntry,
  setMachineEntry,
  setSecret,
} from '../config/config-service.ts'
import { parseSecretRunArgs, runNamedSecrets } from '../config/secret-run.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { subscriptionMonthlyUsdKey } from '../run/run-subscription-cost.ts'
import { log, rawArgv } from './support.ts'

const SUBSCRIPTION_PRICE_HELP = `\nSubscription monthly prices are user-scope keys named subscription.<harness>.monthly_usd, for example ${subscriptionMonthlyUsdKey('codex')} and ${subscriptionMonthlyUsdKey('grok')}.\nExamples:\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('codex')} <usd>\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('grok')} <usd>\n`

function registerConfigSet(config: Command): void {
  config
    .command('set <key> <value>')
    .description(
      'set one configuration value; subscription.<harness>.monthly_usd is a user-scope monthly price in USD',
    )
    .addHelpText('after', SUBSCRIPTION_PRICE_HELP)
    .option('--space', 'write the value in the active space scope')
    .option('--machine', 'write the value in machine configuration')
    .option('--expect <rowVersion>', 'row version required before writing')
    .option('--json', 'write the resulting configuration row as JSON')
    .action(async (key, value, options) => {
      const write = shipToWrite(key, value)
      assertConfigWriteAllowed(write.key, write.value)
      if (options.machine) {
        if (options.space || options.expect)
          throw new Error(
            'refusing machine config set: --machine cannot be combined with --space or --expect',
          )
        const row = setMachineEntry(write.key, write.value)
        if (options.json) log(JSON.stringify(row))
        else
          log(
            `machine settings take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
          )
        return
      }
      const row = await setEntry(
        write.key,
        write.value,
        scope(options),
        expectedRowVersion(options.expect),
      )
      if (options.json) log(configGetPresentation(row, true))
    })
}

const scope = (options: { space?: boolean }): ConfigScope => (options.space ? 'space' : 'user')
type ConfigRow = Awaited<ReturnType<typeof getEntry>>

function expectedRowVersion(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined
  if (value === 'null') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('expected row version must be a positive integer or null')
  }
  return parsed
}

export function assertConfigWriteAllowed(
  key: string,
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): void {
  const normalized = value === undefined ? { key, value } : shipToWrite(key, value)
  if (key.startsWith('autonomy.') && isOrchWorkerProcess(env, pid, inventory)) {
    throw new Error(
      `refusing autonomy config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config ${normalized.value === undefined ? `delete ${normalized.key}` : `set ${normalized.key} ${normalized.value}`}`,
    )
  }
  if (value !== undefined && isShipToConfigKey(key) && storedShipToLevel(value) === undefined)
    throw new Error(`invalid autonomy.ship-to; expected one of ${SHIP_TO_VALUES.join(', ')}`)
}

function shipToWrite(key: string, value: string): { key: string; value: string } {
  if (!isShipToConfigKey(key)) return { key, value }
  return { key: SHIP_TO_CONFIG_KEY, value: storedShipToLevel(value) ?? value }
}

export const configGetPresentation = (row: ConfigRow, json: boolean) =>
  json ? JSON.stringify(row) : row.value
export const configListPresentation = (
  rows: { scope: string; key: string; value: string }[],
  json: boolean,
) => (json ? [JSON.stringify(rows)] : rows.map((row) => `${row.scope}\t${row.key}\t${row.value}`))

function registerMachineCommands(config: Command): void {
  const machine = config.command('machine').description('manage machine encryption identity')
  machine
    .command('init')
    .description('create this machine encryption identity')
    .option('--label <label>', 'label stored for this machine identity')
    .action(async (options) => log(await machineInit(options.label)))
  machine
    .command('show')
    .description('show this machine public encryption identity')
    .action(async () => {
      const shown = await machineShow()
      log(`${shown.keyId}\t${shown.publicKey}`)
    })
  machine
    .command('trust <keyId> <publicKey>')
    .description('trust a machine public key for sealed configuration')
    .option('--label <label>', 'label stored for the trusted machine')
    .option('--yes', 'trust the machine without interactive confirmation')
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
  machine
    .command('revoke <keyId>')
    .description('revoke a trusted machine and reseal configuration')
    .action(async (keyId) => {
      const rows = await machineRevoke(keyId)
      log(
        `revoked ${keyId}; re-sealed ${rows.length} row(s)${rows.length ? `: ${rows.join(', ')}` : ''}`,
      )
    })
}

export function register(program: Command): void {
  const config = program.command('config').description('manage scoped configuration values')
  registerMachineCommands(config)
  config
    .command('get <key>')
    .description('show one configuration value')
    .option('--space', 'read the value from the active space scope')
    .option('--json', 'write the configuration row as JSON')
    .action(async (key, options) => {
      const row = await getEntry(key, scope(options))
      log(configGetPresentation(row, Boolean(options.json)))
    })
  registerConfigSet(config)
  config
    .command('list')
    .description('list configuration values')
    .option('--machine', 'list machine configuration values')
    .option('--json', 'write the configuration rows as JSON')
    .action(async (options) => {
      const rows = options.machine ? listMachineEntries() : await listEntries()
      for (const line of configListPresentation(rows, Boolean(options.json))) log(line)
    })
  config
    .command('delete <key>')
    .description('delete one configuration value')
    .option('--space', 'delete the value from the active space scope')
    .option('--machine', 'delete the value from machine configuration')
    .option('--expect <rowVersion>', 'row version required before deleting')
    .action(async (key, options) => {
      assertConfigWriteAllowed(key, undefined)
      if (options.machine) {
        if (options.space || options.expect)
          throw new Error(
            'refusing machine config delete: --machine cannot be combined with --space or --expect',
          )
        deleteMachineEntry(key)
        log(
          `machine settings take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
        )
        return
      }
      const expected = expectedRowVersion(options.expect)
      if (expected === null)
        throw new Error('delete expected row version must be a positive integer')
      if (isShipToConfigKey(key)) {
        const selectedScope = scope(options)
        const rows = (await listEntries()).filter(
          (row) => row.scope === selectedScope && isShipToConfigKey(row.key),
        )
        if (!rows.length) await deleteEntry(key, selectedScope, expected)
        for (const row of rows) {
          await deleteEntry(
            row.key,
            selectedScope,
            row.key === key ? (expected ?? row.rowVersion) : row.rowVersion,
          )
        }
      } else await deleteEntry(key, scope(options), expected)
    })

  const secret = config.command('secret').description('manage sealed configuration values')
  secret
    .command('set <key>')
    .description('set a sealed value from standard input')
    .option('--space', 'write the value in the active space scope')
    .action(async (key, options) => {
      if (process.stdin.isTTY) throw new Error('secret value must be provided on stdin')
      const decision = sealSecretDecision(key, await Bun.stdin.text())
      if (decision.kind === 'refuse') throw new Error(decision.refusal)
      await setSecret(key, decision.value, scope(options))
    })
  secret
    .command('list')
    .description('list sealed configuration keys')
    .action(async () => {
      for (const row of await listSecrets()) log(`${row.scope}\t${row.key}\t${row.updatedAt}`)
    })
  secret
    .command('delete <key>')
    .description('delete one sealed configuration value')
    .option('--space', 'delete the value from the active space scope')
    .action(async (key, options) => {
      await deleteSecret(key, scope(options))
    })
  secret
    .command('run')
    .description('run a command with named secrets resolved')
    // The child's own -h and --help belong to the child.
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .action(async (_options, command: Command) => {
      process.exitCode = await runNamedSecrets(parseSecretRunArgs(rawArgv(command).slice(3)))
    })
}
