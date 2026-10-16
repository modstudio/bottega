// concern: cli
/** Registers record authentication grammar. Must not own authentication behavior. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isHttpAddress } from '../../../shared/record-client-addresses.ts'
import { projects } from '../project/projects.ts'
import { retireOutboxRowWithDependencyProof } from '../record/outbox-operator.ts'
import { retryOutboxRow } from '../record/outbox-quarantine.ts'
import { signInCommand, signUpCommand, whoamiCommand } from '../record/record-auth-command.ts'
import {
  recordAuditSecretsCommand,
  recordDoctorCommand,
  recordMigrateCommand,
  recordPublicDocClearCommand,
  recordPublicDocDesignateCommand,
  recordPublicDocListCommand,
  recordRedactSyncedCommand,
  recordSpaceAcceptCommand,
  recordSpaceCreateCommand,
  recordSpaceInvitationsCommand,
  recordSpaceInviteCommand,
  recordSpaceListCommand,
  recordSpaceMoveProjectCommand,
  recordSpaceSwitchCommand,
} from '../record/record-command.ts'
import { publishSnapshotsCommand } from '../record/record-publish.ts'
import { pushDocsCommand } from '../record/record-push-docs.ts'
import { useHostedRecord } from '../record/record-use.ts'
import { requireHostedRecord } from '../record/record-write-authority.ts'
import { log } from './support.ts'

const presentation = { log }

export function httpAddress(value: string): string {
  if (!isHttpAddress(value)) throw new Error('address must be an http or https URL')
  const url = new URL(value)
  if (url.username || url.password)
    throw new Error('address must not contain credentials; remove them')
  if (url.search) throw new Error('address must not contain a query; remove it')
  if (url.hash) throw new Error('address must not contain a fragment; remove it')
  return value
}

async function promptPassword(): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await terminal.question('Record password: ')
  } finally {
    terminal.close()
  }
}

function hostedCommand<T>(command: string, action: () => T): T {
  requireHostedRecord(command)
  return action()
}

function hostedRecord<T>(verb: string, action: () => T): T {
  return hostedCommand(`${PLATFORM_SLUG} record ${verb}`, action)
}

function registerUseCommand(record: Command): void {
  record
    .command('use')
    .description('bind this machine to a hosted record')
    .argument('<address>', 'public record API address', httpAddress)
    .action((address) => useHostedRecord(String(address), { log, warn: console.warn }))
}

function registerIdentityCommands(record: Command): void {
  const presentation = { log }
  record
    .command('sign-up')
    .description('create a hosted record account and sign in')
    .requiredOption('--email <email>', 'email address for the new account')
    .requiredOption('--name <name>', 'display name for the new account')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record sign-up`, () =>
        signUpCommand(String(options.email), String(options.name), promptPassword, { log }),
      ),
    )
  record
    .command('sign-in')
    .description('sign in to the hosted record')
    .requiredOption('--email <email>', 'email address of the account')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record sign-in`, () =>
        signInCommand(String(options.email), promptPassword, { log }),
      ),
    )
  record
    .command('whoami')
    .description('show the signed-in hosted record identity')
    .action(() => hostedCommand(`${PLATFORM_SLUG} record whoami`, () => whoamiCommand({ log })))
  record
    .command('migrate')
    .description('apply pending hosted record migrations')
    .action(() => hostedRecord('migrate', () => recordMigrateCommand(presentation)))
}

function registerPublicDocCommands(record: Command): void {
  const presentation = { log }
  const publicDoc = record.command('public-doc').description('manage public document projects')
  publicDoc
    .command('designate')
    .description('designate a project as the public document source')
    .argument('<space-slug>')
    .argument('<project-name>')
    .action((spaceSlug, projectName) =>
      hostedCommand(`${PLATFORM_SLUG} record public-doc designate`, () =>
        recordPublicDocDesignateCommand(String(spaceSlug), String(projectName), presentation),
      ),
    )
  publicDoc
    .command('list')
    .description('list public document project designations')
    .option('--json', 'write the designations as JSON')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record public-doc list`, () =>
        recordPublicDocListCommand({ json: Boolean(options.json) }, presentation),
      ),
    )
  publicDoc
    .command('clear')
    .description('clear a public document project designation')
    .argument('<space-slug>')
    .argument('<project-name>')
    .action((spaceSlug, projectName) =>
      hostedCommand(`${PLATFORM_SLUG} record public-doc clear`, () =>
        recordPublicDocClearCommand(String(spaceSlug), String(projectName), presentation),
      ),
    )
}

export function register(program: Command): void {
  const record = program.command('record').description('manage the hosted record and its outbox')
  registerUseCommand(record)
  registerIdentityCommands(record)
  registerPublicDocCommands(record)
  record
    .command('audit-secrets')
    .description('scan local outbox payloads for secret material')
    .option('--json', 'write the audit findings as JSON')
    .option('--ids', 'include row identifiers in text output')
    .action((options) =>
      recordAuditSecretsCommand(
        { json: Boolean(options.json), ids: Boolean(options.ids) },
        presentation,
      ),
    )
  record
    .command('redact-synced')
    .description('redact secret material from synchronized record payloads')
    .option('--rules <comma-list>', 'comma-separated redaction rules to apply')
    .option('--dry-run', 'report redactions without writing them')
    .action((options) =>
      recordRedactSyncedCommand(
        {
          ...(options.rules === undefined ? {} : { rules: String(options.rules) }),
          dryRun: Boolean(options.dryRun),
        },
        presentation,
      ),
    )
  const outbox = record.command('outbox').description('operate on orchestrator outbox rows')
  outbox
    .command('retry')
    .description('queue an outbox row for another delivery attempt')
    .argument('<row-id>')
    .action((rowId) => {
      retryOutboxRow(Number(rowId))
      log(`outbox row ${String(rowId)} will retry on the next sync`)
    })
  outbox
    .command('retire')
    .description('retire an outbox row after proving its dependencies')
    .argument('<row-id>')
    .requiredOption('--reason <text>', 'reason the outbox row is retired')
    .action((rowId, options) => {
      retireOutboxRowWithDependencyProof(Number(rowId), String(options.reason))
      log(`outbox row ${String(rowId)} retired`)
    })
  const space = record.command('space').description('manage hosted record spaces')
  space
    .command('list')
    .description('list spaces available to the signed-in account')
    .action(() => hostedRecord('space list', () => recordSpaceListCommand(presentation)))
  space
    .command('create')
    .description('create a hosted record space')
    .requiredOption('--name <name>', 'display name for the new space')
    .requiredOption('--slug <slug>', 'URL slug for the new space')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record space create`, () =>
        recordSpaceCreateCommand(String(options.name), String(options.slug), presentation),
      ),
    )
  space
    .command('switch')
    .description('select the active hosted record space')
    .argument('<slug-or-id>')
    .action((value) =>
      hostedCommand(`${PLATFORM_SLUG} record space switch`, () =>
        recordSpaceSwitchCommand(String(value), presentation),
      ),
    )
  space
    .command('invite')
    .description('invite an email address to the active space')
    .requiredOption('--email <email>', 'email address to invite')
    .option('--role <role>', 'member, admin, or owner', 'member')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record space invite`, () =>
        recordSpaceInviteCommand(String(options.email), String(options.role), presentation),
      ),
    )
  space
    .command('invitations')
    .description('list invitations available to the signed-in account')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record space invitations`, () =>
        recordSpaceInvitationsCommand(presentation),
      ),
    )
  space
    .command('accept')
    .description('accept an invitation to a hosted record space')
    .argument('<invitation-id>')
    .action((value) =>
      hostedCommand(`${PLATFORM_SLUG} record space accept`, () =>
        recordSpaceAcceptCommand(String(value), presentation),
      ),
    )
  space
    .command('move-project')
    .description('move a registered project to another space')
    .argument('<project>')
    .requiredOption('--to <slug-or-id>', 'destination space slug or identifier')
    .option('--dry-run', 'report the project records that would move')
    .option('--confirm <count>', 'expected number of project records to move')
    .action((project, options) =>
      hostedCommand(`${PLATFORM_SLUG} record space move-project`, () =>
        recordSpaceMoveProjectCommand(
          String(project),
          String(options.to),
          {
            dryRun: Boolean(options.dryRun),
            ...(options.confirm === undefined ? {} : { confirm: Number(options.confirm) }),
          },
          presentation,
        ),
      ),
    )
  record
    .command('push-docs')
    .description('push local documents to the hosted record')
    .option('--dry-run', 'report document changes without pushing them')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record push-docs`, () =>
        pushDocsCommand({ dryRun: Boolean(options.dryRun) }, { log }),
      ),
    )
  record
    .command('publish')
    .description('publish hosted record snapshots')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record publish`, () =>
        publishSnapshotsCommand({
          log,
          setExitCode: (code) => {
            process.exitCode = code
          },
        }),
      ),
    )
  record
    .command('doctor')
    .description('check hosted record configuration and access')
    .action(() =>
      recordDoctorCommand(
        {
          log,
          exitCode: (code) => {
            process.exitCode = code
          },
        },
        projects().map((project) => ({
          name: project.name,
          space: project.settings.space ?? null,
        })),
      ),
    )
}
