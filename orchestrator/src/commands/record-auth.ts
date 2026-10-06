// concern: cli
/** Registers record authentication grammar. Must not own authentication behavior. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { projects } from '../project/projects.ts'
import { retireOutboxRowWithDependencyProof } from '../record/outbox-operator.ts'
import { retryOutboxRow } from '../record/outbox-quarantine.ts'
import { signInCommand, signUpCommand, whoamiCommand } from '../record/record-auth-command.ts'
import {
  recordAuditSecretsCommand,
  recordDoctorCommand,
  recordMigrateCommand,
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
import { requireHostedRecord } from '../record/record-write-authority.ts'
import { log } from './support.ts'

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

export function register(program: Command): void {
  const record = program.command('record')
  const presentation = { log }
  record
    .command('sign-up')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>')
    .action((options) =>
      hostedCommand('orch record sign-up', () =>
        signUpCommand(String(options.email), String(options.name), promptPassword, { log }),
      ),
    )
  record
    .command('sign-in')
    .requiredOption('--email <email>')
    .action((options) =>
      hostedCommand('orch record sign-in', () =>
        signInCommand(String(options.email), promptPassword, { log }),
      ),
    )
  record
    .command('whoami')
    .action(() => hostedCommand('orch record whoami', () => whoamiCommand({ log })))
  record
    .command('migrate')
    .action(() => hostedCommand('orch record migrate', () => recordMigrateCommand(presentation)))
  record
    .command('audit-secrets')
    .option('--json')
    .option('--ids')
    .action((options) =>
      recordAuditSecretsCommand(
        { json: Boolean(options.json), ids: Boolean(options.ids) },
        presentation,
      ),
    )
  record
    .command('redact-synced')
    .option('--rules <comma-list>')
    .option('--dry-run')
    .action((options) =>
      recordRedactSyncedCommand(
        {
          ...(options.rules === undefined ? {} : { rules: String(options.rules) }),
          dryRun: Boolean(options.dryRun),
        },
        presentation,
      ),
    )
  const outbox = record.command('outbox')
  outbox
    .command('retry')
    .argument('<row-id>')
    .action((rowId) => {
      retryOutboxRow(Number(rowId))
      log(`outbox row ${String(rowId)} will retry on the next sync`)
    })
  outbox
    .command('retire')
    .argument('<row-id>')
    .requiredOption('--reason <text>')
    .action((rowId, options) => {
      retireOutboxRowWithDependencyProof(Number(rowId), String(options.reason))
      log(`outbox row ${String(rowId)} retired`)
    })
  const space = record.command('space')
  space
    .command('list')
    .action(() =>
      hostedCommand('orch record space list', () => recordSpaceListCommand(presentation)),
    )
  space
    .command('create')
    .requiredOption('--name <name>')
    .requiredOption('--slug <slug>')
    .action((options) =>
      hostedCommand('orch record space create', () =>
        recordSpaceCreateCommand(String(options.name), String(options.slug), presentation),
      ),
    )
  space
    .command('switch')
    .argument('<slug-or-id>')
    .action((value) =>
      hostedCommand('orch record space switch', () =>
        recordSpaceSwitchCommand(String(value), presentation),
      ),
    )
  space
    .command('invite')
    .requiredOption('--email <email>')
    .option('--role <role>', 'member, admin, or owner', 'member')
    .action((options) =>
      hostedCommand('orch record space invite', () =>
        recordSpaceInviteCommand(String(options.email), String(options.role), presentation),
      ),
    )
  space
    .command('invitations')
    .action(() =>
      hostedCommand('orch record space invitations', () =>
        recordSpaceInvitationsCommand(presentation),
      ),
    )
  space
    .command('accept')
    .argument('<invitation-id>')
    .action((value) =>
      hostedCommand('orch record space accept', () =>
        recordSpaceAcceptCommand(String(value), presentation),
      ),
    )
  space
    .command('move-project')
    .argument('<project>')
    .requiredOption('--to <slug-or-id>')
    .option('--dry-run')
    .option('--confirm <count>')
    .action((project, options) =>
      hostedCommand('orch record space move-project', () =>
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
    .option('--dry-run')
    .action((options) =>
      hostedCommand('orch record push-docs', () =>
        pushDocsCommand({ dryRun: Boolean(options.dryRun) }, { log }),
      ),
    )
  record.command('publish').action(() =>
    hostedCommand('orch record publish', () =>
      publishSnapshotsCommand({
        log,
        setExitCode: (code) => {
          process.exitCode = code
        },
      }),
    ),
  )
  record.command('doctor').action(() =>
    recordDoctorCommand(
      {
        log,
        exitCode: (code) => {
          process.exitCode = code
        },
      },
      projects().map((project) => ({ name: project.name, space: project.settings.space ?? null })),
    ),
  )
}
