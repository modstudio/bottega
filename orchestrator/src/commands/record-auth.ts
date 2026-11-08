// concern: cli
/** Registers record authentication grammar. Must not own authentication behavior. */
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  isModerationHideReason,
  MODERATION_HIDE_REASONS,
  type ModerationHideReason,
} from '../../../shared/moderation-hide-reason.ts'
import { parseNoteLabel } from '../../../shared/note-label.ts'
import {
  isOutsidePauseHours,
  OUTSIDE_PAUSE_DEFAULT_HOURS,
  OUTSIDE_PAUSE_MAX_HOURS,
} from '../../../shared/outside-write-decision.ts'
import { isHttpAddress } from '../../../shared/record-client-addresses.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { projects } from '../project/projects.ts'
import { retireOutboxRowWithDependencyProof } from '../record/outbox-operator.ts'
import { retryOutboxRow, retryOutboxRowsMatching } from '../record/outbox-quarantine.ts'
import {
  decideRecordPassword,
  PASSWORD_PROMPT_EOF_REFUSAL,
  RECORD_PASSWORD_ENV,
  signInCommand,
  signUpCommand,
  verifyEmailCommand,
  whoamiCommand,
} from '../record/record-auth-command.ts'
import {
  recordAuditSecretsCommand,
  recordDoctorCommand,
  recordMigrateCommand,
  recordPublicDocClearCommand,
  recordPublicDocDesignateCommand,
  recordPublicDocListCommand,
  recordRedactSyncedCommand,
  recordSpaceAcceptCommand,
  recordSpaceAccessGrantCommand,
  recordSpaceAccessListCommand,
  recordSpaceAccessWithdrawCommand,
  recordSpaceCreateCommand,
  recordSpaceDeleteTrialCommand,
  recordSpaceHiddenCommand,
  recordSpaceHideCommand,
  recordSpaceIntakeBlockCommand,
  recordSpaceIntakeBlocksCommand,
  recordSpaceIntakePauseCommand,
  recordSpaceIntakeResumeCommand,
  recordSpaceIntakeSetCommand,
  recordSpaceIntakeShowCommand,
  recordSpaceIntakeUnblockCommand,
  recordSpaceInvitationsCommand,
  recordSpaceInviteCommand,
  recordSpaceListCommand,
  recordSpaceMoveProjectCommand,
  recordSpaceSwitchCommand,
  recordSpaceUnhideCommand,
} from '../record/record-command.ts'
import { publishSnapshotsCommand } from '../record/record-publish.ts'
import { pushCataloguesCommand } from '../record/record-push-catalogues.ts'
import { pushDocsCommand } from '../record/record-push-docs.ts'
import { useHostedRecord } from '../record/record-use.ts'
import { recordPublishAvailability, requireHostedRecord } from '../record/record-write-authority.ts'
import { requestedMachineNames } from './machine-name-options.ts'
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

export async function promptPassword(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  passwordFromEnvironment: string | undefined = process.env[RECORD_PASSWORD_ENV],
): Promise<string> {
  const decision = decideRecordPassword(passwordFromEnvironment, input.isTTY === true)
  if (decision.action === 'use-environment') return decision.password
  if (decision.action === 'refuse') throw new Error(decision.message)

  let muted = false
  const mutedOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk)
      callback()
    },
  }) as Writable & { isTTY: boolean }
  mutedOutput.isTTY = true
  const terminal = createInterface({ input, output: mutedOutput, terminal: true })
  try {
    const answer = terminal.question('Record password: ')
    muted = true
    const password = await Promise.race([
      answer,
      new Promise<never>((_resolve, reject) => {
        terminal.once('close', () => {
          reject(new Error(PASSWORD_PROMPT_EOF_REFUSAL))
        })
      }),
    ])
    muted = false
    output.write('\n')
    return password
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
    .command('verify-email')
    .description('send verification mail to the signed-in account')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record verify-email`, () => verifyEmailCommand({ log })),
    )
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

function registerPushCommands(record: Command): void {
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
    .command('push-catalogues')
    .description('push local catalogues and port items to the hosted record')
    .option('--dry-run', 'report the import plan without writing')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record push-catalogues`, () =>
        pushCataloguesCommand({ dryRun: Boolean(options.dryRun) }, { log }),
      ),
    )
}

function registerSpaceCommands(record: Command): void {
  const space = record.command('space').description('manage hosted record spaces')
  space
    .command('list')
    .description('list spaces available to the signed-in account')
    .action(() => hostedRecord('space list', () => recordSpaceListCommand(presentation)))
  registerSpaceLifetimeCommands(space)
  space
    .command('switch')
    .description('select the active hosted record space')
    .argument('<slug-or-id>')
    .option('--short-name <name>', 'short machine name')
    .option('--display-name <name>', 'display machine name')
    .action((value, options) =>
      hostedCommand(`${PLATFORM_SLUG} record space switch`, async () =>
        recordSpaceSwitchCommand(String(value), presentation, await requestedMachineNames(options)),
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
    .option('--short-name <name>', 'short machine name')
    .option('--display-name <name>', 'display machine name')
    .action((value, options) =>
      hostedCommand(`${PLATFORM_SLUG} record space accept`, async () =>
        recordSpaceAcceptCommand(String(value), presentation, await requestedMachineNames(options)),
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
  registerSpaceAccessCommands(space)
  registerSpaceIntakeCommands(space)
  registerSpaceModerationCommands(space)
}

function registerSpaceLifetimeCommands(space: Command): void {
  space
    .command('create')
    .description('create a hosted record space and report how to switch back')
    .requiredOption('--name <name>', 'display name for the new space')
    .requiredOption('--slug <slug>', 'URL slug for the new space')
    .option('--trial', 'mark this trial-prefixed space for trial teardown')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record space create`, () =>
        recordSpaceCreateCommand(
          String(options.name),
          String(options.slug),
          presentation,
          Boolean(options.trial),
        ),
      ),
    )
  space
    .command('delete-trial')
    .description('tear down one marked trial space and neutralize its trial accounts')
    .argument('<slug>')
    .action((slug) =>
      hostedCommand(`${PLATFORM_SLUG} record space delete-trial`, () =>
        recordSpaceDeleteTrialCommand(String(slug), presentation),
      ),
    )
}

function moderationTarget(value: string): { message: string } | { note: string } {
  if (hasRecordIdShape(value)) return { message: value }
  parseNoteLabel(value)
  return { note: value }
}

function moderationReason(value: string): ModerationHideReason {
  if (!isModerationHideReason(value))
    throw new Error(`reason must be one of: ${MODERATION_HIDE_REASONS.join(', ')}`)
  return value
}

function registerSpaceModerationCommands(space: Command): void {
  space
    .command('hide')
    .description('hide a board message or note; shared-space notices cannot be hidden (owner only)')
    .argument('<message-id|project#number>')
    .requiredOption('--reason <reason>', 'moderation reason', moderationReason)
    .action((value, options) =>
      hostedCommand(`${PLATFORM_SLUG} record space hide`, () =>
        recordSpaceHideCommand(moderationTarget(String(value)), options.reason, presentation),
      ),
    )
  space
    .command('unhide')
    .description('unhide a board message or note (owner only)')
    .argument('<message-id|project#number>')
    .action((value) =>
      hostedCommand(`${PLATFORM_SLUG} record space unhide`, () =>
        recordSpaceUnhideCommand(moderationTarget(String(value)), presentation),
      ),
    )
  space
    .command('hidden')
    .description('list hidden board messages and notes (owner only)')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record space hidden`, () =>
        recordSpaceHiddenCommand(presentation),
      ),
    )
}

function registerSpaceIntakeCommands(space: Command): void {
  const intake = space.command('intake').description('manage the outside intake project')
  intake
    .command('show')
    .description('show the active space outside intake project')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record space intake show`, () =>
        recordSpaceIntakeShowCommand(presentation),
      ),
    )
  intake
    .command('set')
    .description('set the active space outside intake project (owner only)')
    .argument('<project>')
    .action((project) =>
      hostedCommand(`${PLATFORM_SLUG} record space intake set`, () =>
        recordSpaceIntakeSetCommand(String(project), presentation),
      ),
    )
  intake
    .command('pause')
    .description('pause outside writes to the active space (owner only)')
    .option('--hours <n>', 'whole hours to pause', parseOutsideHours, OUTSIDE_PAUSE_DEFAULT_HOURS)
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record space intake pause`, () =>
        recordSpaceIntakePauseCommand(Number(options.hours), presentation),
      ),
    )
  intake
    .command('resume')
    .description('resume outside writes to the active space (owner only)')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record space intake resume`, () =>
        recordSpaceIntakeResumeCommand(presentation),
      ),
    )
  intake
    .command('blocks')
    .description('list outside-author blocks in the active space (owner only)')
    .option('--json', 'write the blocks as JSON')
    .action((options) =>
      hostedCommand(`${PLATFORM_SLUG} record space intake blocks`, () =>
        recordSpaceIntakeBlocksCommand({ json: Boolean(options.json) }, presentation),
      ),
    )
  intake
    .command('block')
    .description('block an outside author from the active space (owner only)')
    .option('--message <id>', 'identify the author by a board message')
    .option('--note <label>', 'identify the author by a project#number note')
    .option('--hours <n>', 'whole hours before the block ends', parseOutsideHours)
    .action((options) => {
      const message = options.message === undefined ? undefined : String(options.message)
      const note = options.note === undefined ? undefined : String(options.note)
      if ((message === undefined) === (note === undefined))
        throw new Error('exactly one of --message or --note is required')
      return hostedCommand(`${PLATFORM_SLUG} record space intake block`, () =>
        recordSpaceIntakeBlockCommand(
          {
            ...(message === undefined ? {} : { message }),
            ...(note === undefined ? {} : { note }),
            ...(options.hours === undefined ? {} : { hours: Number(options.hours) }),
          },
          presentation,
        ),
      )
    })
  intake
    .command('unblock')
    .description('remove an outside-author block from the active space (owner only)')
    .argument('<user-id>')
    .action((userId) =>
      hostedCommand(`${PLATFORM_SLUG} record space intake unblock`, () =>
        recordSpaceIntakeUnblockCommand(String(userId), presentation),
      ),
    )
}

function parseOutsideHours(value: string): number {
  const hours = Number(value)
  if (!isOutsidePauseHours(hours))
    throw new Error(`hours must be a whole number from 1 through ${OUTSIDE_PAUSE_MAX_HOURS}`)
  return hours
}

function registerSpaceAccessCommands(space: Command): void {
  const access = space.command('access').description('manage hosted config access')
  access
    .command('list')
    .description('list members and config access')
    .action(() =>
      hostedCommand(`${PLATFORM_SLUG} record space access list`, () =>
        recordSpaceAccessListCommand(presentation),
      ),
    )
  access
    .command('grant')
    .description('grant config access to a member')
    .argument('<email>')
    .action((email) =>
      hostedCommand(`${PLATFORM_SLUG} record space access grant`, () =>
        recordSpaceAccessGrantCommand(String(email), presentation),
      ),
    )
  access
    .command('withdraw')
    .description('withdraw config access from a member')
    .argument('<email>')
    .action((email) =>
      hostedCommand(`${PLATFORM_SLUG} record space access withdraw`, () =>
        recordSpaceAccessWithdrawCommand(String(email), presentation),
      ),
    )
}

function retryOutboxCommand(rowId: string | undefined, matching: string | undefined): void {
  if ((rowId === undefined) === (matching === undefined)) {
    throw new Error(
      `exactly one retry form is required: \`${PLATFORM_SLUG} record outbox retry <row-id>\` or \`${PLATFORM_SLUG} record outbox retry --matching <text>\``,
    )
  }
  if (rowId !== undefined) {
    retryOutboxRow(Number(rowId))
    log(`outbox row ${String(rowId)} will retry on the next sync`)
    return
  }
  // An empty needle matches every reason, which would retry the whole quarantine.
  if (matching!.trim() === '') {
    throw new Error(
      `--matching requires non-empty text; name part of an orchestrator quarantine reason shown by \`${PLATFORM_SLUG} record outbox\``,
    )
  }
  const count = retryOutboxRowsMatching(matching!)
  log(`${count} orchestrator outbox rows will retry on the next sync`)
}

export function register(program: Command): void {
  const record = program.command('record').description('manage the hosted record and its outbox')
  registerUseCommand(record)
  registerIdentityCommands(record)
  registerPublicDocCommands(record)
  registerPushCommands(record)
  registerSpaceCommands(record)
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
    .argument('[row-id]')
    .option(
      '--matching <text>',
      'retry quarantined orchestrator rows whose reason contains the text',
    )
    .action((rowId, options) =>
      retryOutboxCommand(
        rowId,
        options.matching === undefined ? undefined : String(options.matching),
      ),
    )
  outbox
    .command('retire')
    .description('retire an outbox row after proving its dependencies')
    .argument('<row-id>')
    .requiredOption('--reason <text>', 'reason the outbox row is retired')
    .action((rowId, options) => {
      retireOutboxRowWithDependencyProof(Number(rowId), String(options.reason))
      log(`outbox row ${String(rowId)} retired`)
    })
  record
    .command('publish')
    .description('publish hosted record snapshots')
    .action(() =>
      publishSnapshotsCommand(
        {
          log,
          setExitCode: (code) => {
            process.exitCode = code
          },
        },
        { availability: recordPublishAvailability() },
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
