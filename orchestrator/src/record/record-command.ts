// concern: record-command
/** Presents record migration, space, invitation, and doctor operations. */

import { readMachineValue } from '../../../shared/machine-config.ts'
import { openReadOnlyDatabase } from '../database/db.ts'
import {
  appliedRecordMigrationCount,
  migratePostgres,
  recordMigrationCount,
} from '../postgres/postgres-migrate.ts'
import { projectByName, setProjectRecordSpace } from '../project/projects.ts'
import {
  redactSyncedOutbox,
  renderSyncedRedaction,
  syncedRedactionRules,
} from './outbox-redaction.ts'
import { auditOutboxSecrets, renderOutboxSecretAudit } from './outbox-secret-audit.ts'
import { diagnoseRecord, recordDoctorExitCode, redactRecordPasswords } from './record-doctor.ts'
import {
  acceptRecordInvitation,
  createRecordSpace,
  inviteToActiveRecordSpace,
  pendingRecordInvitations,
  recordMemberships,
  recordSpaceRole,
  switchRecordSpace,
} from './record-space.ts'
import { moveRecordProjectSpace } from './record-space-move.ts'
import { recordTunnelFailure } from './record-tunnel-error.ts'

type Presentation = { log(value: string): void; exitCode?(code: number): void }

function recordUrl(): string {
  const url = process.env.ORCH_RECORD_URL
  if (!url) throw new Error('ORCH_RECORD_URL is required for record operations')
  return url
}

export async function recordMigrateCommand(presentation: Presentation): Promise<void> {
  const url = process.env.ORCH_RECORD_MIGRATE_URL
  if (!url) throw new Error('ORCH_RECORD_MIGRATE_URL is required to migrate the record')
  let before: number
  let after: number
  try {
    before = await appliedRecordMigrationCount(url)
    await migratePostgres(url)
    after = await appliedRecordMigrationCount(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const redacted = redactRecordPasswords(message, [url])
    throw new Error(recordTunnelFailure(redacted, readMachineValue('record.tunnel_app')))
  }
  const shipped = recordMigrationCount()
  presentation.log(`record migrations applied before ${before}; after ${after}; shipped ${shipped}`)
  if (after !== shipped) {
    throw new Error(
      `record migration confirmation failed: applied ${after}; shipped ${shipped}; resolve the schema mismatch before deploying`,
    )
  }
}

export async function recordSpaceListCommand(presentation: Presentation): Promise<void> {
  const result = await recordMemberships(recordUrl())
  for (const membership of result.memberships) {
    presentation.log(
      `${membership.spaceId === result.activeSpaceId ? '* ' : '  '}${membership.slug}\t${membership.name}\t${membership.role}\t${membership.permission}`,
    )
  }
}

export async function recordSpaceCreateCommand(
  name: string,
  slug: string,
  presentation: Presentation,
): Promise<void> {
  const created = await createRecordSpace(recordUrl(), name, slug)
  presentation.log(`${created.id}\t${created.slug}`)
}

export async function recordSpaceSwitchCommand(
  value: string,
  presentation: Presentation,
): Promise<void> {
  const selected = await switchRecordSpace(recordUrl(), value)
  presentation.log(`active record space ${selected.slug}`)
}

export async function recordSpaceInviteCommand(
  email: string,
  role: string,
  presentation: Presentation,
): Promise<void> {
  const id = await inviteToActiveRecordSpace(recordUrl(), email, recordSpaceRole(role))
  presentation.log(id)
}

export async function recordSpaceInvitationsCommand(presentation: Presentation): Promise<void> {
  for (const invitation of await pendingRecordInvitations(recordUrl())) {
    presentation.log(
      `${invitation.id}\t${invitation.spaceName}\t${invitation.spaceSlug}\t${invitation.role}\t${invitation.inviterEmail}\t${invitation.expiresAt.toISOString()}`,
    )
  }
}

export async function recordSpaceAcceptCommand(
  invitationId: string,
  presentation: Presentation,
): Promise<void> {
  const spaceId = await acceptRecordInvitation(recordUrl(), invitationId)
  presentation.log(`accepted record invitation ${invitationId}; active space ${spaceId}`)
}

export async function recordSpaceMoveProjectCommand(
  projectName: string,
  destination: string,
  options: { dryRun: boolean; confirm?: number },
  presentation: Presentation,
  dependencies = {
    recordUrl,
    findProject: projectByName,
    moveProject: moveRecordProjectSpace,
    setProjectSpace: setProjectRecordSpace,
  },
): Promise<void> {
  if (
    options.confirm !== undefined &&
    (!Number.isSafeInteger(options.confirm) || options.confirm < 0)
  ) {
    throw new Error('--confirm must be a non-negative integer')
  }
  if (options.dryRun && options.confirm !== undefined) {
    throw new Error('--dry-run and --confirm cannot be used together')
  }
  const project = dependencies.findProject(projectName)
  if (!project) throw new Error(`no project "${projectName}" in the local register`)
  const result = await dependencies.moveProject({
    url: dependencies.recordUrl(),
    project: projectName,
    source: project.settings.space,
    destination,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  })
  for (const row of result.rows) {
    presentation.log(
      `${row.tableName}\t${row.rowCount}\t${row.moved ? 'moved' : 'not moved'}\t${row.reachedBy}`,
    )
  }
  if (options.confirm === undefined) {
    presentation.log(
      `dry run: ${result.total} rows would move; rerun with --confirm ${result.total}`,
    )
    return
  }
  try {
    dependencies.setProjectSpace(projectName, result.destinationSlug)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `record rows moved to ${result.destinationSlug}, but the local register declaration did not: ${detail}\n` +
        `the next sync would target the old space until it is set; run \`orch project set ${projectName} --settings '{"space":"${result.destinationSlug}"}'\``,
    )
  }
  presentation.log(
    `moved ${result.total} rows; project ${projectName} now declares record space ${result.destinationSlug}`,
  )
  presentation.log('local hosted-row caches were not rewritten; the next pull reconciles them')
}

export function recordAuditSecretsCommand(
  options: { json: boolean; ids: boolean },
  presentation: Presentation,
  database?: Parameters<typeof auditOutboxSecrets>[0],
): void {
  const owned = database === undefined
  const conn = database ?? openReadOnlyDatabase()
  try {
    const report = auditOutboxSecrets(conn, { ids: options.ids })
    if (options.json) {
      presentation.log(JSON.stringify(report))
      return
    }
    const text = renderOutboxSecretAudit(report)
    if (text) presentation.log(text)
  } finally {
    if (owned) conn.close()
  }
}

export function recordRedactSyncedCommand(
  options: { rules?: string; dryRun: boolean },
  presentation: Presentation,
  database?: Parameters<typeof redactSyncedOutbox>[1],
): void {
  const result = redactSyncedOutbox(
    { rules: syncedRedactionRules(options.rules), dryRun: options.dryRun },
    database,
  )
  presentation.log(renderSyncedRedaction(result))
}

export async function recordDoctorCommand(
  presentation: Presentation,
  projects: Array<{ name: string; space: string | null }> = [],
): Promise<void> {
  const checks = await diagnoseRecord({ projects })
  for (const check of checks) {
    presentation.log(`${check.name}: ${check.status}${check.detail ? ` — ${check.detail}` : ''}`)
  }
  presentation.exitCode?.(recordDoctorExitCode(checks))
}
