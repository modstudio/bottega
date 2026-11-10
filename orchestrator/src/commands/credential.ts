// concern: credential-commands
/** Owns the public credential grammar and adapts it to hosted sealed configuration. */

import type { Command } from 'commander'
import { configClient } from '../../../shared/config-client.ts'
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_MODES,
  CREDENTIAL_SLUG_PATTERN,
  type CredentialEnvironment,
  type CredentialMode,
} from '../../../shared/credential.ts'
import { credentialPayerFromScope } from '../../../shared/credential-resolution.ts'
import {
  RECORD_ACTIVE_SPACE_REMEDY,
  recordSpaceMembershipRefusal,
} from '../../../shared/record-remedies.ts'
import { recordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import {
  CREDENTIAL_SLOTS,
  credentialDisplayName,
  credentialSlot,
  parseCredentialSlot,
} from '../config/credential-presentation.ts'
import {
  accountCredentialBinding,
  type CredentialAddress,
  deleteCredential,
  listCredentials,
  projectCredentialAddress,
  projectCredentialBinding,
  reachCredential,
  resolveCredentialValue,
  resolveProjectCredential,
  setCredential,
} from '../config/credential-service.ts'
import { runWithEnvironment } from '../config/secret-run.ts'
import { projectByName } from '../project/projects.ts'
import { log } from './support.ts'

type BindingOptions = {
  project?: string
  space?: string
  account?: boolean
  shared?: boolean
  mode?: string
  env?: string
  reach?: string
  spaces?: string
}
function identityName(value: string): { provider: string; name: string | null; type: string } {
  const parts = value.split('/')
  if (parts.length !== 2 && parts.length !== 3)
    throw new Error(
      'credential name must be <provider>/<type> or <provider>/<name>/<type> using lowercase slugs',
    )
  const provider = parts[0] ?? ''
  const name = parts.length === 3 ? (parts[1] ?? '') : null
  const type = parts.at(-1) ?? ''
  if (
    !provider ||
    !type ||
    !CREDENTIAL_SLUG_PATTERN.test(provider) ||
    (name !== null && !CREDENTIAL_SLUG_PATTERN.test(name)) ||
    !CREDENTIAL_SLUG_PATTERN.test(type)
  )
    throw new Error(
      'credential name must be <provider>/<type> or <provider>/<name>/<type> using lowercase slugs',
    )
  return { provider, name, type }
}

function environment(value?: string): CredentialEnvironment {
  const selected = value ?? 'local'
  if (!CREDENTIAL_ENVIRONMENTS.includes(selected as CredentialEnvironment))
    throw new Error(`--env must be ${CREDENTIAL_ENVIRONMENTS.join(' or ')}`)
  return selected as CredentialEnvironment
}

function mode(value?: string): CredentialMode {
  const selected = value ?? 'default'
  if (!CREDENTIAL_MODES.includes(selected as CredentialMode))
    throw new Error(`--mode must be ${CREDENTIAL_MODES.join(' or ')}`)
  return selected as CredentialMode
}

type CredentialBindingAddress = Omit<
  CredentialAddress,
  'provider' | 'name' | 'type' | 'mode' | 'environment' | 'payer'
>

export function validateBindingExclusivity(options: BindingOptions): void {
  if (
    [options.project !== undefined, options.space !== undefined, options.account === true].filter(
      Boolean,
    ).length > 1
  )
    throw new Error('--account, --project, and --space are mutually exclusive')
}

async function bindingAddress(
  options: BindingOptions,
  writeVerb?: string,
): Promise<CredentialBindingAddress> {
  validateBindingExclusivity(options)
  const client = configClient()
  const project = options.project ? projectByName(options.project) : null
  if (options.project && !project) throw new Error(`no project ${options.project}`)
  if (project) return projectCredentialBinding(project, client)
  if (options.account) return accountCredentialBinding(client)
  const who = await client.whoami()
  const memberships = parseRecordSpaceMemberships(who.memberships)
  if (writeVerb) {
    const destination = recordSpaceOwnerDestination(
      writeVerb,
      { space: options.space, project: options.project, account: options.account },
      memberships,
    )
    if (destination.kind === 'refused') throw new Error(destination.remedy)
    if (destination.kind !== 'space') throw new Error('credential owner was not resolved')
    return {
      projectId: null,
      projectName: undefined,
      spaceName: destination.slug,
      destinationSpaceId: destination.spaceId,
    }
  }
  let destinationSpaceId = options.space
    ? recordSpaceMembership(options.space, memberships)?.spaceId
    : who.activeSpaceId
  if (!destinationSpaceId) {
    if (options.space) throw new Error(recordSpaceMembershipRefusal(options.space))
    throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  }
  const membership = recordSpaceMembership(destinationSpaceId, memberships)
  if (!membership) throw new Error(recordSpaceMembershipRefusal(destinationSpaceId))
  return {
    projectId: null,
    projectName: undefined,
    spaceName: membership.slug,
    destinationSpaceId,
  }
}

async function address(
  name: string,
  options: BindingOptions,
  writeVerb?: string,
): Promise<CredentialAddress> {
  validateBindingExclusivity(options)
  const identity = identityName(name)
  if (options.project) {
    const project = projectByName(options.project)
    if (!project) throw new Error(`no project ${options.project}`)
    const target = await projectCredentialAddress(project, identity.provider)
    return {
      ...target,
      ...identity,
      mode: mode(options.mode),
      environment: environment(options.env),
      payer: options.shared ? 'shared' : 'personal',
    }
  }
  return {
    ...identity,
    ...(await bindingAddress(options, writeVerb)),
    mode: mode(options.mode),
    environment: environment(options.env),
    payer: options.shared ? 'shared' : 'personal',
    account: options.account || undefined,
  }
}

function addBindingOptions(command: Command, includeShared = true, includeAccount = true): Command {
  command.option('--project <name>', 'bind to a registered project')
  command.option('--space <slug>', 'bind to a record space')
  if (includeAccount) command.option('--account', 'bind to the caller account')
  if (includeShared) command.option('--shared', 'use the shared payer instead of personal')
  return command
    .option('--mode <mode>', CREDENTIAL_MODES.join(' or '))
    .option('--env <environment>', CREDENTIAL_ENVIRONMENTS.join(' or '))
}

async function parsedReach(value: string): Promise<string[] | null> {
  if (value === 'all') return null
  const slugs = value.split(',').filter(Boolean)
  if (slugs.length === 0) throw new Error('reach must be all or a comma-separated space slug list')
  const memberships = parseRecordSpaceMemberships((await configClient().whoami()).memberships)
  const ids: string[] = []
  for (const slug of slugs) {
    const membership = recordSpaceMembership(slug, memberships)
    if (!membership) {
      const valid = memberships
        .map((item) => item.slug)
        .sort()
        .join(', ')
      throw new Error(`unknown reach space ${slug}; choose one of: ${valid || '(none)'}`)
    }
    if (!ids.includes(membership.spaceId)) ids.push(membership.spaceId)
  }
  return ids
}

function validateAccountOptions(options: BindingOptions): void {
  if (options.account && options.shared)
    throw new Error('--account and --shared are mutually exclusive')
  if (options.reach !== undefined && !options.account) throw new Error('--reach requires --account')
}

async function resolveAction(
  name: string,
  argv: string[],
  options: BindingOptions & { revealToEnv?: string },
): Promise<void> {
  const target = await address(name, options)
  const client = configClient()
  if (options.revealToEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.revealToEnv))
      throw new Error('--reveal-to-env must be an environment-variable name')
    if (argv.length === 0) throw new Error('--reveal-to-env requires -- <argv>')
    const result = await resolveCredentialValue(target, client)
    process.exitCode = await runWithEnvironment(argv, {
      ...process.env,
      [options.revealToEnv]: result.value,
    })
    return
  }
  if (argv.length > 0) throw new Error('command argv requires --reveal-to-env <VAR>')
  const result = await resolveProjectCredential(target, client)
  log(
    `${credentialDisplayName(target.provider, target.name, target.type, target.mode, target.environment)}\t${credentialSlot(result.credential.payer, result.credential.projectId, result.credential.account !== undefined)}\t${result.reason}`,
  )
}

function registerReachCommand(credential: Command): void {
  addBindingOptions(credential.command('reach <provider/type>'), false)
    .description('change an account credential reach')
    .requiredOption('--spaces <spaces>', 'all or comma-separated space slugs')
    .action(async (name, options: BindingOptions) => {
      if (!options.account) throw new Error('reach requires --account')
      await reachCredential(await address(name, options), await parsedReach(options.spaces!))
    })
}

export function registerCredentialCommands(program: Command): void {
  const credential = program.command('credential').description('manage typed provider credentials')
  addBindingOptions(credential.command('set <provider/type>'), true)
    .description('set a credential from standard input')
    .option('--reach <spaces>', 'all or comma-separated space slugs')
    .action(async (name, options: BindingOptions) => {
      validateAccountOptions(options)
      if (process.stdin.isTTY) throw new Error('credential value must be provided on stdin')
      const target = await address(name, options, 'credential set')
      if (options.account && options.reach !== undefined)
        target.reachSpaceIds = await parsedReach(options.reach)
      await setCredential(target, await Bun.stdin.text())
    })
  addBindingOptions(credential.command('delete <provider/type>'), true)
    .description('delete a credential')
    .action(async (name, options: BindingOptions) => {
      validateAccountOptions(options)
      await deleteCredential(await address(name, options, 'credential delete'))
    })
  addBindingOptions(credential.command('list'), false)
    .description('list credential metadata and masked hints')
    .action(async (options: BindingOptions) => {
      validateAccountOptions(options)
      const target = await bindingAddress(options)
      const selectedMode = options.mode ? mode(options.mode) : undefined
      const selectedEnvironment = options.env ? environment(options.env) : undefined
      const reachSlugs = options.account
        ? new Map(
            parseRecordSpaceMemberships((await configClient().whoami()).memberships).map((item) => [
              item.spaceId,
              item.slug,
            ]),
          )
        : null
      for (const row of await listCredentials(target.destinationSpaceId, {
        mode: selectedMode,
        environment: selectedEnvironment,
        projectId: options.project ? target.projectId! : undefined,
        account: options.account,
      })) {
        const reach = options.account
          ? `\t${row.reachSpaceIds == null ? 'all' : row.reachSpaceIds.map((id) => reachSlugs?.get(id) ?? id).join(',')}`
          : ''
        log(
          `${credentialDisplayName(row.provider, row.name, row.type, row.mode, row.environment)}\t${credentialSlot(credentialPayerFromScope(row.scope), row.projectId ?? null, Boolean(options.account))}\t${row.hint}${reach}`,
        )
      }
    })
  addBindingOptions(credential.command('prefer <provider/type>'), false, false)
    .description('set or clear a payer preference')
    .option('--use <slot>', CREDENTIAL_SLOTS.join(' or '))
    .option('--clear', 'clear the preference')
    .action(async (name, options: BindingOptions & { use?: string; clear?: boolean }) => {
      if (Boolean(options.project) === Boolean(options.space))
        throw new Error('prefer requires exactly one of --project or --space')
      if (Boolean(options.use) === Boolean(options.clear))
        throw new Error('choose exactly one of --use or --clear')
      const target = await address(name, options)
      const client = configClient()
      const input = {
        projectId: target.projectId,
        provider: target.provider,
        name: target.name,
        type: target.type,
        mode: target.mode,
        environment: target.environment,
        destinationSpaceId: target.destinationSpaceId,
      }
      if (options.clear) {
        await client.deleteCredentialPreference(input)
        return
      }
      const slot = parseCredentialSlot(options.use!)
      if (!slot) throw new Error(`--use must be ${CREDENTIAL_SLOTS.join(', ')}`)
      await client.putCredentialPreference({
        ...input,
        ...slot,
      })
    })
  registerReachCommand(credential)
  credential
    .command('resolve <provider/type> [argv...]')
    .requiredOption('--project <name>', 'resolve for a registered project')
    .option('--mode <mode>', CREDENTIAL_MODES.join(' or '))
    .option('--env <environment>', CREDENTIAL_ENVIRONMENTS.join(' or '))
    .option('--reveal-to-env <variable>', 'run argv with the plaintext in this variable')
    .description('show which credential would pay for a project')
    .action(resolveAction)
}
