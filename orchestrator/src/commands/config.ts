// concern: config-commands
/** Owns only the `bottega machine config` grammar and presentation. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigClient, ConfigScope } from '../../../shared/config-client.ts'
import { isDelegationKey } from '../../../shared/delegation-mode.ts'
import { listMachineEntries } from '../../../shared/machine-config.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import {
  isShipToConfigKey,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  storedShipToLevel,
} from '../../../shared/ship-to.ts'
import {
  configHome,
  deleteEntry,
  deleteMachineEntry,
  deleteSecret,
  getConfigEntry,
  listEntries,
  listSecrets,
  machineInit,
  machineRevoke,
  machineShow,
  sealSecretDecision,
  setConfigEntry,
  setSecret,
} from '../config/config-service.ts'
import { hostedConfigClient } from '../config/hosted-config-call-outcome.ts'
import { trustMachine } from '../config/machine-trust.ts'
import { machineRegister } from '../config/named-space-config.ts'
import { parseSecretRunArgs, runNamedSecrets } from '../config/secret-run.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { subscriptionMonthlyUsdKey } from '../run/run-subscription-cost.ts'
import { requestedMachineNames } from './machine-name-options.ts'
import { log, rawArgv } from './support.ts'

const SUBSCRIPTION_PRICE_HELP = `\nSubscription monthly prices are user-scope keys named subscription.<harness>.monthly_usd, for example ${subscriptionMonthlyUsdKey('codex')} and ${subscriptionMonthlyUsdKey('grok')}.\nExamples:\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('codex')} <usd>\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('grok')} <usd>\n`

function registerConfigSet(config: Command): void {
  config
    .command('set <key> <value>')
    .description(
      'set one configuration value; subscription.<harness>.monthly_usd is a user-scope monthly price in USD',
    )
    .addHelpText('after', SUBSCRIPTION_PRICE_HELP)
    .option('--space <slug>', 'write the value in this record space')
    .option('--machine', 'write the value in machine configuration')
    .option('--expect <rowVersion>', 'row version required before writing')
    .option('--json', 'write the resulting configuration row as JSON')
    .action(async (key, value, options) => {
      const write = shipToWrite(key, value)
      assertConfigWriteAllowed(write.key, write.value)
      if (options.machine && options.space) {
        throw new Error('refusing machine config set: --machine cannot be combined with --space')
      }
      const requestedHome = options.machine ? 'machine' : options.space ? 'space' : undefined
      const home = configHome(write.key, requestedHome)
      const client = home === 'machine' ? undefined : hostedConfigClient()
      const target = client
        ? await configWriteTarget('machine config set', options.space, client)
        : undefined
      const written = await setConfigEntry(
        write.key,
        write.value,
        requestedHome,
        expectedRowVersion(options.expect),
        client,
        process.env,
        () => client ?? hostedConfigClient(),
        target?.destination,
      )
      if (options.json) log(configSetPresentation(written))
      else {
        log(
          `wrote ${written.key} to ${written.home === 'machine' ? 'machine' : `hosted ${written.home} scope`}`,
        )
        if (
          written.home === 'machine' &&
          (written.key.startsWith('autonomy.') || written.key === 'machine.global_use')
        )
          log(
            `machine settings take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
          )
      }
    })
}

function registerConfigGet(config: Command): void {
  config
    .command('get <key>')
    .description('show one configuration value')
    .option('--space', 'read the value from the active space scope')
    .option('--machine', 'read the value from machine.toml only')
    .option('--json', 'write the configuration row as JSON')
    .action(async (key, options) => {
      if (options.machine && options.space)
        throw new Error('refusing machine config get: --machine cannot be combined with --space')
      const result = await getConfigEntry(
        key,
        options.machine ? 'machine' : options.space ? 'space' : undefined,
      )
      for (const line of configReadPresentation(result, Boolean(options.json))) log(line)
    })
}

export async function configWriteTarget(
  verb: string,
  requested: string | undefined,
  client: ConfigClient,
): Promise<{ scope: ConfigScope; destination: { destinationSpaceId: string } }> {
  if (requested) {
    const destination = await selectedMachineSpace(verb, requested, client)
    return {
      scope: 'space',
      destination: { destinationSpaceId: destination.spaceId },
    }
  }
  const who = await client.whoami()
  const memberships = parseRecordSpaceMemberships(who.memberships)
  const decision = recordWriteSpace(
    { kind: 'personal' },
    { declaredSpaces: {}, personalSpaceId: who.personalSpaceId, memberships },
  )
  if ('refused' in decision) throw new Error(decision.remedy)
  return { scope: 'user', destination: { destinationSpaceId: decision.spaceId } }
}
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
  if (operatorOnlyMachineKey(key) && isOrchWorkerProcess(env, pid, inventory)) {
    const machineFlag = isDelegationKey(normalized.key) ? '--machine ' : ''
    throw new Error(
      `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config ${normalized.value === undefined ? `delete ${machineFlag}${normalized.key}` : `set ${machineFlag}${normalized.key} ${normalized.value}`}`,
    )
  }
  if (value !== undefined && isShipToConfigKey(key) && storedShipToLevel(value) === undefined)
    throw new Error(`invalid autonomy.ship-to; expected one of ${SHIP_TO_VALUES.join(', ')}`)
}

function operatorOnlyMachineKey(key: string): boolean {
  return key.startsWith('autonomy.') || isDelegationKey(key)
}

function shipToWrite(key: string, value: string): { key: string; value: string } {
  if (!isShipToConfigKey(key)) return { key, value }
  return { key: SHIP_TO_CONFIG_KEY, value: storedShipToLevel(value) ?? value }
}

export const configSetPresentation = (result: Awaited<ReturnType<typeof setConfigEntry>>): string =>
  JSON.stringify(result.row)

export const configReadPresentation = (
  result: Awaited<ReturnType<typeof getConfigEntry>>,
  json: boolean,
) =>
  json
    ? [JSON.stringify(result)]
    : [
        result.value,
        `source: ${result.source}`,
        ...(result.outrankingMachineValue === undefined
          ? []
          : [
              `machine.toml value outranks it at the local user scope: ${result.outrankingMachineValue}`,
            ]),
        ...result.ignoredHostedScopes.map((ignored) => `ignored hosted value: ${ignored} scope`),
      ]
export const configListPresentation = (
  rows: { scope: string; key: string; value: string }[],
  json: boolean,
) => (json ? [JSON.stringify(rows)] : rows.map((row) => `${row.scope}\t${row.key}\t${row.value}`))

function registerMachineCommands(config: Command): void {
  const machine = config.command('machine').description('manage machine encryption identity')
  machine
    .command('init')
    .description('create this machine encryption identity')
    .option('--space <slug>', 'initialize for this record space')
    .option('--label <label>', 'label stored for this machine identity')
    .option('--short-name <name>', 'short machine name')
    .option('--display-name <name>', 'display machine name')
    .action(async (options) => {
      const client = hostedConfigClient()
      const selected = await selectedMachineSpace(
        'machine config machine init',
        options.space,
        client,
      )
      log(
        await machineInit(
          selected.spaceId,
          options.label,
          client,
          process.env,
          await requestedMachineNames(options),
        ),
      )
    })
  machine
    .command('show')
    .description('show this machine public encryption identity')
    .action(async () => {
      const shown = await machineShow()
      log(`${shown.keyId}\t${shown.publicKey}`)
    })
  machine
    .command('register')
    .description('register this machine encryption identity in a record space')
    .option('--space <slug>', 'register in this record space')
    .option('--label <label>', 'label stored for this machine identity')
    .action(async (options) => {
      const client = hostedConfigClient()
      const selected = await selectedMachineSpace(
        'machine config machine register',
        options.space,
        client,
      )
      for (const line of await machineRegister(selected, options.label, client)) log(line)
    })
  machine
    .command('trust <keyId> <publicKey>')
    .description('trust a machine public key for sealed configuration')
    .option('--space <slug>', 'trust in this record space')
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
      const client = hostedConfigClient()
      const selected = await selectedMachineSpace(
        'machine config machine trust',
        options.space,
        client,
      )
      await trustMachine(keyId, publicKey, label, selected, client)
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

async function selectedMachineSpace(
  verb: string,
  requested: string | undefined,
  client: ConfigClient,
): Promise<{ spaceId: string; slug: string }> {
  const destination = await resolveRecordSpaceOwnerDestination(
    verb,
    { space: requested },
    [],
    async () => parseRecordSpaceMemberships((await client.whoami()).memberships),
  )
  return destination
}

/** Read the piped value, refuse a blank one, and seal the rest in the requested scope. */
async function sealPipedSecret(key: string, options: { space?: string }): Promise<void> {
  if (process.stdin.isTTY) throw new Error('secret value must be provided on stdin')
  const client = hostedConfigClient()
  const target = await configWriteTarget('machine config secret set', options.space, client)
  const decision = sealSecretDecision(key, await Bun.stdin.text(), target.scope)
  if (decision.kind === 'refuse') throw new Error(decision.refusal)
  await setSecret(key, decision.value, target.scope, client, { destination: target.destination })
}

export function register(program: Command): void {
  const config = program.command('config').description('manage scoped configuration values')
  registerMachineCommands(config)
  registerConfigGet(config)
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
    .option('--space <slug>', 'delete the value from this record space')
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
      const client = hostedConfigClient()
      const target = await configWriteTarget('machine config delete', options.space, client)
      if (isShipToConfigKey(key)) {
        const selectedScope = target.scope
        const rows = (await listEntries(client, target.destination)).filter(
          (row) => row.scope === selectedScope && isShipToConfigKey(row.key),
        )
        if (!rows.length)
          await deleteEntry(key, selectedScope, expected, client, target.destination)
        for (const row of rows) {
          await deleteEntry(
            row.key,
            selectedScope,
            row.key === key ? (expected ?? row.rowVersion) : row.rowVersion,
            client,
            target.destination,
          )
        }
      } else await deleteEntry(key, target.scope, expected, client, target.destination)
    })

  const secret = config.command('secret').description('manage sealed configuration values')
  secret
    .command('set <key>')
    .description('set a sealed value from standard input')
    .option('--space <slug>', 'write the value in this record space')
    .action(async (key, options) => sealPipedSecret(key, options))
  secret
    .command('list')
    .description('list sealed configuration keys')
    .action(async () => {
      for (const row of await listSecrets()) log(`${row.scope}\t${row.key}\t${row.updatedAt}`)
    })
  secret
    .command('delete <key>')
    .description('delete one sealed configuration value')
    .option('--space <slug>', 'delete the value from this record space')
    .action(async (key, options) => {
      const client = hostedConfigClient()
      const target = await configWriteTarget('machine config secret delete', options.space, client)
      await deleteSecret(key, target.scope, client, { destination: target.destination })
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
