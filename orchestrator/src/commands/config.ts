// concern: config-commands
/** Owns only the `bottega machine config` grammar and presentation. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigClient, ConfigDestination, ConfigScope } from '../../../shared/config-client.ts'
import { credentialMachineTrustCommands } from '../../../shared/credential-machine-trust.ts'
import { isDelegationKey } from '../../../shared/delegation-mode.ts'
import { KEYSTORE_ENV } from '../../../shared/key-store-constants.ts'
import { DISPLAY_TIMEZONE_KEY } from '../../../shared/machine-config.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import {
  isShipToConfigKey,
  SHIP_TO_CONFIG_KEY,
  SHIP_TO_VALUES,
  storedShipToLevel,
} from '../../../shared/ship-to.ts'
import type { getConfigEntry, setConfigEntry } from '../config/config-service.ts'
import type { pinnedConfigDestination } from '../config/secret-write-target.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { subscriptionMonthlyUsdKey } from '../run/run-subscription-cost.ts'
import { registerMachineJoinCommands } from './machine-join-commands.ts'
import { log, rawArgv } from './support.ts'

const SUBSCRIPTION_PRICE_HELP = `\nSubscription monthly prices are user-scope keys named subscription.<harness>.monthly_usd, for example ${subscriptionMonthlyUsdKey('codex')} and ${subscriptionMonthlyUsdKey('grok')}.\nExamples:\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('codex')} <usd>\n  ${PLATFORM_SLUG} machine config set ${subscriptionMonthlyUsdKey('grok')} <usd>\n`
const KEYSTORE_HELP = `\nmachine.keystore selects keychain or file storage for the record session and the machine key. ${KEYSTORE_ENV} overrides it, and ${PLATFORM_SLUG} machine setup chooses file on Linux when no usable keychain is found.\n`

function registerConfigSet(config: Command): void {
  config
    .command('set <key> <value>')
    .description(
      'set one configuration value; subscription.<harness>.monthly_usd is a user-scope monthly price in USD',
    )
    .addHelpText('after', `${SUBSCRIPTION_PRICE_HELP}${KEYSTORE_HELP}`)
    .option('--space <slug>', 'write the value in this record space')
    .option('--machine', 'write the value in machine configuration')
    .option('--expect <rowVersion>', 'row version required before writing')
    .option('--json', 'write the resulting configuration row as JSON')
    .action(async (key, value, options) => {
      const [{ setRemedy }, { configHome, setConfigEntry }, { hostedConfigClient }] =
        await Promise.all([
          import('../config/config-entry-policy.ts'),
          import('../config/config-service.ts'),
          import('../config/hosted-config-call-outcome.ts'),
        ])
      const write = shipToWrite(key, value)
      assertConfigWriteAllowed(write.key, write.value)
      const space = configSpaceSelection('set', options.space, false, () =>
        setRemedy(write.key, 'space', '<slug>', write.value),
      )
      if (options.machine && space !== undefined) {
        throw new Error('refusing machine config set: --machine cannot be combined with --space')
      }
      const requestedHome = options.machine
        ? 'machine'
        : typeof space === 'string'
          ? 'space'
          : undefined
      const home = configHome(write.key, requestedHome)
      const client = home === 'machine' ? undefined : hostedConfigClient()
      const target = client
        ? await configWriteTarget(
            'machine config set',
            typeof space === 'string' ? space : undefined,
            client,
          )
        : undefined
      const written = await setConfigEntry(
        write.key,
        write.value,
        requestedHome,
        expectedRowVersion(options.expect),
        client,
        process.env,
        () => client ?? hostedConfigClient(),
        {
          destination: target?.destination,
          ...(target?.scope === 'space'
            ? {
                remedy: setRemedy(write.key, 'space', target.spaceSlug, write.value),
              }
            : {}),
        },
      )
      logConfigSetResult(written, Boolean(options.json))
    })
}

function logConfigSetResult(
  written: Awaited<ReturnType<typeof setConfigEntry>>,
  json: boolean,
): void {
  if (json) {
    log(configSetPresentation(written))
    return
  }
  log(
    `wrote ${written.row.key} to ${written.home === 'machine' ? 'machine' : `hosted ${written.home} scope`}`,
  )
  if (
    written.home === 'machine' &&
    (written.row.key.startsWith('autonomy.') || written.row.key === 'machine.global_use')
  )
    log(
      `machine settings take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
    )
}

function registerConfigGet(config: Command): void {
  config
    .command('get [key]')
    .description('show one configuration value')
    .option('--space [slug]', 'read the value from the active or named space scope')
    .option('--machine', 'read the value from machine.toml only')
    .option('--json', 'write the configuration row as JSON')
    .action(async (parsedKey, options) => {
      const [{ configHome, getConfigEntry }, { hostedConfigClient }] = await Promise.all([
        import('../config/config-service.ts'),
        import('../config/hosted-config-call-outcome.ts'),
      ])
      const { key, space } = configGetRequest(parsedKey, options.space)
      if (options.machine && space !== undefined)
        throw new Error('refusing machine config get: --machine cannot be combined with --space')
      const requested = options.machine ? 'machine' : space !== undefined ? 'space' : undefined
      const client =
        configHome(key, requested, 'get') === 'machine' ? undefined : hostedConfigClient()
      const destination = client
        ? await configReadDestination('machine config get', space, client)
        : undefined
      const result = await getConfigEntry(
        key,
        requested,
        client,
        process.env,
        () => client ?? hostedConfigClient(),
        destination,
      )
      for (const line of configReadPresentation(result, Boolean(options.json))) log(line)
    })
}

export function configGetRequest(
  parsedKey: string | undefined,
  parsedSpace: true | string | undefined,
): { key: string; space: true | string | undefined } {
  let key = parsedKey
  let space = parsedSpace
  if (key === undefined && typeof space === 'string' && space.length > 0) {
    key = space
    space = true
  }
  space = configSpaceSelection(
    'get',
    space,
    true,
    () => `${PLATFORM_SLUG} machine config get ${key ?? '<key>'} --space <slug>`,
  )
  if (key === undefined) throw new Error("missing required argument 'key'")
  return { key, space }
}

export async function configWriteTarget(
  verb: string,
  requested: string | undefined,
  client: ConfigClient,
): Promise<
  | {
      scope: 'space'
      destination: { destinationSpaceId: string }
      spaceSlug: string
    }
  | {
      scope: 'user'
      destination: { destinationSpaceId: string }
    }
> {
  if (requested) {
    const destination = await selectedMachineSpace(verb, requested, client)
    return {
      scope: 'space',
      destination: { destinationSpaceId: destination.spaceId },
      spaceSlug: destination.slug,
    }
  }
  return {
    scope: 'user',
    destination: await (await import('../config/config-service.ts')).personalConfigWriteDestination(
      client,
    ),
  }
}

export async function configReadDestination(
  verb: string,
  requested: true | string | undefined,
  client: ConfigClient,
): Promise<ConfigDestination> {
  if (typeof requested !== 'string') return {}
  const destination = await selectedMachineSpace(verb, requested, client)
  return { destinationSpaceId: destination.spaceId }
}

export function configSpaceSelection(
  verb: 'delete' | 'get' | 'list' | 'secret delete' | 'secret set' | 'set',
  requested: true | string | undefined,
  allowActive: boolean,
  remedy: () => string,
): true | string | undefined {
  if (requested === '')
    throw new Error(
      `refusing machine config ${verb}: --space requires a slug; retry \`${remedy()}\``,
    )
  if (requested === true && !allowActive)
    throw new Error(
      `refusing machine config ${verb}: --space requires a slug; retry \`${remedy()}\``,
    )
  return requested
}

async function resolveSecretWriteTarget(
  verb: string,
  requested: string | undefined,
  client: ConfigClient,
  env: Parameters<typeof pinnedConfigDestination>[1] = process.env,
): Promise<{
  scope: ConfigScope
  destination: { destinationSpaceId: string }
  spaceSlug?: string
}> {
  const selected = requested ? await selectedMachineSpace(verb, requested, client) : undefined
  return {
    ...(await (
      await import('../config/secret-write-target.ts')
    ).secretWriteTarget(selected?.spaceId, client, env)),
    ...(selected ? { spaceSlug: selected.slug } : {}),
  }
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
  registerMachineJoinCommands(machine, selectedMachineSpace)
  registerMachineIdentityCommands(machine)
  registerMachineTrustCommands(machine)
}

const retireUnusedDefaultLocalProjectAfterBind = async () =>
  (
    await import('../project/default-local-project-retirement.ts')
  ).attemptDefaultLocalProjectRetirement({ log })

function registerMachineIdentityCommands(machine: Command): void {
  machine
    .command('init')
    .description('create this machine encryption identity')
    .option('--space <slug>', 'initialize for this record space')
    .option('--label <label>', 'label stored for this machine identity')
    .option('--short-name <name>', 'short machine name')
    .option('--display-name <name>', 'display machine name')
    .action(async (options) => {
      const [services, { hostedConfigClient }, { requestedMachineNames }, adoption] =
        await Promise.all([
          import('../config/config-service.ts'),
          import('../config/hosted-config-call-outcome.ts'),
          import('./machine-name-options.ts'),
          import('../project/project-checkout-adoption.ts'),
        ])
      const client = hostedConfigClient()
      const selected = await selectedMachineSpace(
        'machine config machine init',
        options.space,
        client,
      )
      const keyId = await services.machineInit(
        selected.spaceId,
        options.label,
        client,
        process.env,
        await requestedMachineNames(options),
      )
      await retireUnusedDefaultLocalProjectAfterBind()
      log(keyId)
      await adoption.reportCheckedOutHostedProjects(
        { log },
        credentialMachineTrustCommands({ space: selected.slug }).init,
      )
    })
  machine
    .command('show')
    .description('show this machine public encryption identity')
    .action(async () => {
      const shown = await (await import('../config/config-service.ts')).machineShow()
      log(`${shown.keyId}\t${shown.publicKey}`)
    })
  machine
    .command('register')
    .description('register this machine encryption identity in a record space')
    .option('--space <slug>', 'register in this record space')
    .option('--label <label>', 'label stored for this machine identity')
    .action(async (options) => {
      const [{ hostedConfigClient }, { machineRegister }] = await Promise.all([
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/named-space-config.ts'),
      ])
      const client = hostedConfigClient()
      const selected = await selectedMachineSpace(
        'machine config machine register',
        options.space,
        client,
      )
      for (const line of await machineRegister(selected, options.label, client)) log(line)
    })
}

function registerMachineTrustCommands(machine: Command): void {
  machine
    .command('trust <keyId> <publicKey>')
    .description('trust a machine public key for sealed configuration')
    .option('--space <slug>', 'trust in this record space')
    .option('--label <label>', 'label stored for the trusted machine')
    .option('--yes', 'trust the machine without interactive confirmation')
    .action(async (keyId, publicKey, options) => {
      const [{ createInterface }, { hostedConfigClient }, { trustMachine }] = await Promise.all([
        import('node:readline/promises'),
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/machine-trust.ts'),
      ])
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
      const rows = await (await import('../config/config-service.ts')).machineRevoke(keyId)
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
  const [{ hostedConfigClient }, { sealSecretDecision, secretSetRemedy }, { setSecret }] =
    await Promise.all([
      import('../config/hosted-config-call-outcome.ts'),
      import('../config/secret-set-policy.ts'),
      import('../config/config-service.ts'),
    ])
  const space = configSpaceSelection('secret set', options.space, false, () =>
    secretSetRemedy(key, 'space', '<slug>'),
  )
  if (process.stdin.isTTY) throw new Error('secret value must be provided on stdin')
  const client = hostedConfigClient()
  const target = await resolveSecretWriteTarget(
    'machine config secret set',
    typeof space === 'string' ? space : undefined,
    client,
  )
  const decision = sealSecretDecision(key, await Bun.stdin.text(), target.scope, target.spaceSlug)
  if (decision.kind === 'refuse') throw new Error(decision.refusal)
  await setSecret(key, decision.value, target.scope, client, {
    destination: target.destination,
    remedy: secretSetRemedy(key, target.scope, target.spaceSlug),
  })
}

async function deleteSelectedSecret(key: string, options: { space?: string }): Promise<void> {
  const [{ hostedConfigClient }, { secretDeleteRemedy }, { deleteSecret }] = await Promise.all([
    import('../config/hosted-config-call-outcome.ts'),
    import('../config/secret-set-policy.ts'),
    import('../config/config-service.ts'),
  ])
  const space = configSpaceSelection('secret delete', options.space, false, () =>
    secretDeleteRemedy(key, 'space', '<slug>'),
  )
  const client = hostedConfigClient()
  const target = await resolveSecretWriteTarget(
    'machine config secret delete',
    typeof space === 'string' ? space : undefined,
    client,
  )
  await deleteSecret(key, target.scope, client, { destination: target.destination })
}

function registerConfigList(config: Command): void {
  config
    .command('list')
    .description('list configuration values')
    .option('--space [slug]', 'list values from the active or named space')
    .option('--machine', 'list machine configuration values')
    .option('--json', 'write the configuration rows as JSON')
    .action(async (options) => {
      // The sealed-config empty result below points callers to `credential list`.
      const [{ listMachineEntries }, { hostedConfigClient }, { listEntries }] = await Promise.all([
        import('../../../shared/machine-config.ts'),
        import('../config/hosted-config-call-outcome.ts'),
        import('../config/config-service.ts'),
      ])
      const space = configSpaceSelection(
        'list',
        options.space,
        true,
        () => `${PLATFORM_SLUG} machine config list --space <slug>`,
      )
      if (options.machine && space !== undefined)
        throw new Error('refusing machine config list: --machine cannot be combined with --space')
      const client = options.machine ? undefined : hostedConfigClient()
      const destination = client
        ? await configReadDestination('machine config list', space, client)
        : undefined
      const rows = options.machine ? listMachineEntries() : await listEntries(client, destination)
      for (const line of configListPresentation(rows, Boolean(options.json))) log(line)
    })
}

export function register(
  program: Command,
  typedCredentialPathLookup?: () => Promise<readonly string[]>,
): void {
  const config = program.command('config').description('manage scoped configuration values')
  registerMachineCommands(config)
  registerConfigGet(config)
  registerConfigSet(config)
  registerConfigList(config)
  config
    .command('delete <key>')
    .description('delete one configuration value')
    .option('--space <slug>', 'delete the value from this record space')
    .option('--machine', 'delete the value from machine configuration')
    .option('--expect <rowVersion>', 'row version required before deleting')
    .action((key, options) => deleteSelectedConfig(key, options))

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
      const { listSecrets } = await import('../config/config-service.ts')
      const output = secretListPresentation(await listSecrets())
      for (const line of output.stdout) log(line)
      for (const line of output.stderr) console.error(line)
    })
  secret
    .command('delete <key>')
    .description('delete one sealed configuration value')
    .option('--space <slug>', 'delete the value from this record space')
    .action(deleteSelectedSecret)
  secret
    .command('run')
    .description('run a command with named secrets resolved')
    // The child's own -h and --help belong to the child.
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .action(async (_options, command: Command) => {
      const { parseSecretRunArgs, runNamedSecrets } = await import('../config/secret-run.ts')
      process.exitCode = await runNamedSecrets(
        parseSecretRunArgs(rawArgv(command).slice(3)),
        typedCredentialPathLookup,
      )
    })
}

export function secretListPresentation(
  rows: readonly { scope: string; key: string; updatedAt: string }[],
): { stdout: string[]; stderr: string[] } {
  if (rows.length === 0)
    return {
      stdout: [],
      stderr: [
        `no config secrets in this space (environment default); typed provider credentials: ${PLATFORM_SLUG} credential list`,
      ],
    }
  return {
    stdout: rows.map((row) => `${row.scope}\t${row.key}\t${row.updatedAt}`),
    stderr: [],
  }
}

export async function deleteSelectedConfig(
  key: string,
  options: { expect?: string; machine?: boolean; space?: string },
  client?: ConfigClient,
): Promise<void> {
  const [{ deleteEntry, deleteMachineEntry, listEntries }, { hostedConfigClient }] =
    await Promise.all([
      import('../config/config-service.ts'),
      import('../config/hosted-config-call-outcome.ts'),
    ])
  assertConfigWriteAllowed(key, undefined)
  const space = configSpaceSelection(
    'delete',
    options.space,
    false,
    () => `${PLATFORM_SLUG} machine config delete ${key} --space <slug>`,
  )
  if (options.machine) {
    if (space !== undefined || options.expect)
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
  if (expected === null) throw new Error('delete expected row version must be a positive integer')
  const hostedClient = client ?? hostedConfigClient()
  const target = await configWriteTarget(
    'machine config delete',
    typeof space === 'string' ? space : undefined,
    hostedClient,
  )
  if (isShipToConfigKey(key)) {
    const selectedScope = target.scope
    const rows = (await listEntries(hostedClient, target.destination)).filter(
      (row) => row.scope === selectedScope && isShipToConfigKey(row.key),
    )
    if (!rows.length)
      await deleteEntry(key, selectedScope, expected, hostedClient, target.destination)
    for (const row of rows) {
      await deleteEntry(
        row.key,
        selectedScope,
        row.key === key ? (expected ?? row.rowVersion) : row.rowVersion,
        hostedClient,
        target.destination,
      )
    }
  } else await deleteEntry(key, target.scope, expected, hostedClient, target.destination)
  if (key === DISPLAY_TIMEZONE_KEY)
    (await import('../config/display-timezone-cache.ts')).refreshDisplayTimezoneCache(null)
}
