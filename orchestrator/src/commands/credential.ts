// concern: credential-commands
/** Owns the public credential grammar and adapts it to hosted sealed configuration. */

import type { Command } from 'commander'
import { configClient } from '../../../shared/config-client.ts'
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_SLUG_PATTERN,
  type CredentialEnvironment,
} from '../../../shared/credential.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import {
  credentialDisplayName,
  credentialPayerFromScope,
  credentialSlot,
  resolveCredential,
} from '../config/credential.ts'
import {
  type CredentialAddress,
  deleteCredential,
  listCredentials,
  setCredential,
} from '../config/credential-service.ts'
import { projectByName } from '../project/projects.ts'
import {
  noActiveRecordSpaceRefusal,
  recordSpaceMembershipRefusal,
} from '../record/record-project-destination.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { log } from './support.ts'

type BindingOptions = { project?: string; space?: string; shared?: boolean; env?: string }

function identityName(value: string): { provider: string; type: string } {
  const [provider, type, extra] = value.split('/')
  if (
    !provider ||
    !type ||
    extra ||
    !CREDENTIAL_SLUG_PATTERN.test(provider) ||
    !CREDENTIAL_SLUG_PATTERN.test(type)
  )
    throw new Error('credential name must be <lowercase-provider>/<lowercase-type>')
  return { provider, type }
}

function environment(value?: string): CredentialEnvironment {
  const selected = value ?? 'default'
  if (
    !CREDENTIAL_ENVIRONMENTS.includes(selected as CredentialEnvironment) ||
    (selected === 'default' && value)
  )
    throw new Error('--env must be live or test')
  return selected as CredentialEnvironment
}

type CredentialBindingAddress = Omit<
  CredentialAddress,
  'provider' | 'type' | 'environment' | 'payer'
>

async function bindingAddress(options: BindingOptions): Promise<CredentialBindingAddress> {
  if (options.project && options.space)
    throw new Error('--project and --space are mutually exclusive')
  const client = configClient()
  const who = await client.whoami()
  const project = options.project ? projectByName(options.project) : null
  if (options.project && !project) throw new Error(`no project ${options.project}`)
  if (project && !project.recordId)
    throw new Error(`project ${project.name} has no hosted record identity`)
  const memberships = parseRecordSpaceMemberships(who.memberships)
  let destinationSpaceId: string
  if (project) {
    destinationSpaceId = await requireProjectRecordDestination(
      project.name,
      project.settings,
      client,
    )
  } else if (options.space) {
    const membership = recordSpaceMembership(options.space, memberships)
    if (!membership) throw new Error(recordSpaceMembershipRefusal(options.space))
    destinationSpaceId = membership.spaceId
  } else {
    if (!who.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
    destinationSpaceId = who.activeSpaceId
  }
  const membership = recordSpaceMembership(destinationSpaceId, memberships)
  if (!membership) throw new Error(recordSpaceMembershipRefusal(destinationSpaceId))
  return {
    projectId: project?.recordId ?? null,
    projectName: project?.name,
    spaceName: membership.slug,
    destinationSpaceId,
  }
}

async function address(name: string, options: BindingOptions): Promise<CredentialAddress> {
  return {
    ...identityName(name),
    ...(await bindingAddress(options)),
    environment: environment(options.env),
    payer: options.shared ? 'shared' : 'personal',
  }
}

function addBindingOptions(command: Command, includeShared = true): Command {
  command.option('--project <name>', 'bind to a registered project')
  command.option('--space <slug>', 'bind to a record space')
  if (includeShared) command.option('--shared', 'use the shared payer instead of personal')
  return command.option('--env <environment>', 'live or test')
}

export function registerCredentialCommands(program: Command): void {
  const credential = program.command('credential').description('manage typed provider credentials')
  addBindingOptions(credential.command('set <provider/type>'), true)
    .description('set a credential from standard input')
    .action(async (name, options: BindingOptions) => {
      if (process.stdin.isTTY) throw new Error('credential value must be provided on stdin')
      await setCredential(await address(name, options), await Bun.stdin.text())
    })
  addBindingOptions(credential.command('delete <provider/type>'), true)
    .description('delete a credential')
    .action(async (name, options: BindingOptions) => {
      await deleteCredential(await address(name, options))
    })
  addBindingOptions(credential.command('list'), false)
    .description('list credential metadata and masked hints')
    .action(async (options: BindingOptions) => {
      const target = await bindingAddress(options)
      const selectedEnvironment = options.env ? environment(options.env) : undefined
      for (const row of await listCredentials(target.destinationSpaceId, {
        environment: selectedEnvironment,
        projectId: options.project ? target.projectId! : undefined,
      })) {
        log(
          `${credentialDisplayName(row.provider, row.type, row.environment)}\t${credentialSlot(credentialPayerFromScope(row.scope), row.projectId ?? null)}\t${row.hint}`,
        )
      }
    })
  addBindingOptions(credential.command('prefer <provider/type>'), false)
    .description('set or clear a payer preference')
    .option('--use <slot>', 'personal|shared@project|space')
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
        type: target.type,
        environment: target.environment,
        destinationSpaceId: target.destinationSpaceId,
      }
      if (options.clear) {
        await client.deleteCredentialPreference(input)
        return
      }
      const match = /^(personal|shared)@(project|space)$/.exec(options.use!)
      if (!match)
        throw new Error(
          '--use must be personal@project, personal@space, shared@project, or shared@space',
        )
      await client.putCredentialPreference({
        ...input,
        payer: match[1] as 'personal' | 'shared',
        binding: match[2] as 'project' | 'space',
      })
    })
  credential
    .command('resolve <provider/type>')
    .requiredOption('--project <name>', 'resolve for a registered project')
    .option('--env <environment>', 'live or test')
    .description('show which credential would pay for a project')
    .action(async (name, options: BindingOptions) => {
      const target = await address(name, options)
      const client = configClient()
      const rows = await listCredentials(target.destinationSpaceId, {}, client)
      const preferences = await client.listCredentialPreferences({
        destinationSpaceId: target.destinationSpaceId,
      })
      const result = resolveCredential({
        spaceId: target.destinationSpaceId,
        projectId: target.projectId!,
        projectName: target.projectName!,
        provider: target.provider,
        type: target.type,
        environment: target.environment,
        candidates: rows.map((row) => ({
          spaceId: target.destinationSpaceId,
          projectId: row.projectId ?? null,
          payer: credentialPayerFromScope(row.scope),
          provider: row.provider,
          type: row.type,
          environment: row.environment,
        })),
        preferences,
      })
      if (result.kind === 'refused') throw new Error(result.refusal)
      log(
        `${credentialDisplayName(target.provider, target.type, target.environment)}\t${credentialSlot(result.credential.payer, result.credential.projectId)}\t${result.reason}`,
      )
    })
}
