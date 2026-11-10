// concern: record-command
/** Presents record migration, space, invitation, and doctor operations. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import type { ModerationHideReason } from '../../../shared/moderation-hide-reason.ts'
import { recordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
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
  clearPublicDocProject,
  designatePublicDocProject,
  listPublicDocProjects,
  type PublicDocDesignation,
} from './record-public-doc-designation.ts'
import {
  acceptRecordInvitation,
  blockRecordSpaceOutsideAuthor,
  createRecordSpace,
  deleteTrialSpace,
  grantRecordSpaceConfigAccess,
  hideRecordSpaceRow,
  inviteToRecordSpace,
  listRecordSpaceConfigAccess,
  listRecordSpaceHiddenRows,
  listRecordSpaceOutsideBlocks,
  pauseRecordSpaceOutsideIntake,
  pendingRecordInvitations,
  recordMemberships,
  recordSpaceCreateReport,
  recordSpaceRole,
  resumeRecordSpaceOutsideIntake,
  setRecordSpaceOutsideIntake,
  showRecordSpaceOutsideIntake,
  switchRecordSpace,
  unblockRecordSpaceOutsideAuthor,
  unhideRecordSpaceRow,
  withdrawRecordSpaceConfigAccess,
} from './record-space.ts'
import { ensureAllSpaceBuiltIns } from './record-space-built-ins.ts'
import { moveRecordProjectSpace } from './record-space-move.ts'
import { recordTunnelFailure } from './record-tunnel-error.ts'

type Presentation = { log(value: string): void; exitCode?(code: number): void }

function recordUrl(): string {
  const url = process.env.BOTTEGA_RECORD_URL
  if (!url) throw new Error('BOTTEGA_RECORD_URL is required for record operations')
  return url
}

function recordOwnerUrl(): string {
  const url = process.env.BOTTEGA_RECORD_MIGRATE_URL
  if (!url) {
    throw new Error('BOTTEGA_RECORD_MIGRATE_URL is required to manage public document designations')
  }
  return url
}

export async function recordMigrateCommand(
  presentation: Presentation,
  dependencies = {
    appliedMigrationCount: appliedRecordMigrationCount,
    migrate: migratePostgres,
    migrationCount: recordMigrationCount,
    ensureBuiltIns: ensureAllSpaceBuiltIns,
  },
): Promise<void> {
  const url = process.env.BOTTEGA_RECORD_MIGRATE_URL
  if (!url) throw new Error('BOTTEGA_RECORD_MIGRATE_URL is required to migrate the record')
  let before: number
  let after: number
  try {
    before = await dependencies.appliedMigrationCount(url)
    await dependencies.migrate(url)
    after = await dependencies.appliedMigrationCount(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const redacted = redactRecordPasswords(message, [url])
    throw new Error(
      recordTunnelFailure(redacted, {
        tunnelApp: readMachineValue('record.tunnel_app'),
        requiresTunnel: true,
      }),
    )
  }
  const shipped = dependencies.migrationCount()
  presentation.log(`record migrations applied before ${before}; after ${after}; shipped ${shipped}`)
  if (after !== shipped) {
    throw new Error(
      `record migration confirmation failed: applied ${after}; shipped ${shipped}; resolve the schema mismatch before deploying`,
    )
  }
  const builtIns = await dependencies.ensureBuiltIns(url)
  presentation.log(
    `space built-ins inserted ${builtIns.inserted}; already present ${builtIns.alreadyPresent}`,
  )
}

export async function recordPublicDocDesignateCommand(
  spaceSlug: string,
  projectName: string,
  presentation: Presentation,
): Promise<void> {
  const project = projectByName(projectName)
  if (!project) throw new Error(`no project "${projectName}"`)
  const result = await designatePublicDocProject({
    actorUrl: recordUrl(),
    ownerUrl: recordOwnerUrl(),
    spaceSlug,
    projectName,
    projectId: project.recordId,
  })
  presentation.log(
    result.changed
      ? `designated ${spaceSlug}\t${projectName}\t${result.spaceId}\t${result.projectId}`
      : `already designated ${spaceSlug}\t${projectName}\t${result.spaceId}\t${result.projectId}`,
  )
}

export async function recordPublicDocListCommand(
  options: { json: boolean },
  presentation: Presentation,
): Promise<void> {
  const rows = await listPublicDocProjects({ actorUrl: recordUrl(), ownerUrl: recordOwnerUrl() })
  for (const line of renderPublicDocDesignationList(rows, options.json)) presentation.log(line)
}

export function renderPublicDocDesignationList(
  rows: readonly PublicDocDesignation[],
  json: boolean,
): string[] {
  if (json) return [JSON.stringify(rows)]
  if (!rows.length) return ['no project is designated']
  const lines: string[] = []
  for (const row of rows) {
    lines.push(
      row.resolvable
        ? `${row.space_slug}\t${row.project_name}\t${row.space_id}\t${row.project_id}`
        : `-\t-\t${row.space_id}\t${row.project_id}\tunresolvable`,
    )
  }
  return lines
}

export async function recordPublicDocClearCommand(
  spaceSlug: string,
  projectName: string,
  presentation: Presentation,
): Promise<void> {
  const project = projectByName(projectName)
  if (!project) throw new Error(`no project "${projectName}"`)
  const result = await clearPublicDocProject({
    actorUrl: recordUrl(),
    ownerUrl: recordOwnerUrl(),
    spaceSlug,
    projectName,
    projectId: project.recordId,
  })
  presentation.log(`cleared ${spaceSlug}\t${projectName}\t${result.spaceId}\t${result.projectId}`)
}

export async function recordSpaceListCommand(presentation: Presentation): Promise<void> {
  const result = await recordMemberships()
  for (const membership of result.memberships) {
    presentation.log(
      `${membership.spaceId === result.activeSpaceId ? '* ' : '  '}${membership.slug}\t${membership.name}\t${membership.role}\t${membership.permission}`,
    )
  }
}

export async function recordSpaceAccessListCommand(presentation: Presentation): Promise<void> {
  for (const member of await listRecordSpaceConfigAccess())
    presentation.log(
      `${member.email}\t${member.role}\t${member.permission}\t${member.configAccess ? 'config' : 'no-config'}`,
    )
}

export async function recordSpaceAccessGrantCommand(
  email: string,
  space: string | undefined,
  presentation: Presentation,
): Promise<void> {
  await grantRecordSpaceConfigAccess(
    email,
    await recordSpaceWriteDestination('record space access grant', space),
  )
  presentation.log(`granted config access to ${email}`)
}

export async function recordSpaceAccessWithdrawCommand(
  email: string,
  space: string | undefined,
  presentation: Presentation,
): Promise<void> {
  const result = await withdrawRecordSpaceConfigAccess(
    email,
    await recordSpaceWriteDestination('record space access withdraw', space),
  )
  for (const keyId of result.revokedMachineKeyIds) presentation.log(`revoked machine\t${keyId}`)
  for (const key of result.readableSecretKeys) presentation.log(`replace development key\t${key}`)
  presentation.log(
    `withdrew config access from ${email}; replace the listed development keys because ${PLATFORM_SLUG} cannot replace them`,
  )
}

export async function recordSpaceIntakeShowCommand(presentation: Presentation): Promise<void> {
  const intake = await showRecordSpaceOutsideIntake()
  presentation.log(
    intake
      ? `${intake.project}\t${intake.projectId}${intake.pausedUntil ? `\tpaused until ${intake.pausedUntil}` : ''}`
      : 'no outside intake project',
  )
}

export async function recordSpaceIntakePauseCommand(
  hours: number,
  presentation: Presentation,
): Promise<void> {
  const intake = await pauseRecordSpaceOutsideIntake(hours)
  presentation.log(`outside writes paused until ${intake.pausedUntil}`)
}

export async function recordSpaceIntakeResumeCommand(presentation: Presentation): Promise<void> {
  await resumeRecordSpaceOutsideIntake()
  presentation.log('outside writes resumed')
}

export async function recordSpaceIntakeBlocksCommand(
  options: { json: boolean },
  presentation: Presentation,
): Promise<void> {
  const blocks = await listRecordSpaceOutsideBlocks()
  if (options.json) {
    presentation.log(JSON.stringify(blocks))
    return
  }
  for (const block of blocks)
    presentation.log(
      `${block.userId}\t${block.blockedUntil ?? 'no end'}\t${block.blockedByUserId}\t${block.createdAt}`,
    )
}

export async function recordSpaceIntakeBlockCommand(
  input: { message?: string; note?: string; hours?: number },
  presentation: Presentation,
): Promise<void> {
  const block = await blockRecordSpaceOutsideAuthor(input)
  presentation.log(`blocked outside author ${block.userId}\t${block.blockedUntil ?? 'no end'}`)
}

export async function recordSpaceIntakeUnblockCommand(
  userId: string,
  presentation: Presentation,
): Promise<void> {
  await unblockRecordSpaceOutsideAuthor(userId)
  presentation.log(`unblocked outside author ${userId}`)
}

export async function recordSpaceHideCommand(
  target: { message?: string; note?: string },
  reason: ModerationHideReason,
  presentation: Presentation,
): Promise<void> {
  const hidden = await hideRecordSpaceRow({ ...target, reason })
  presentation.log(`hidden ${hidden.kind} ${hidden.kind === 'note' ? hidden.label : hidden.id}`)
}

export async function recordSpaceUnhideCommand(
  target: { message?: string; note?: string },
  presentation: Presentation,
): Promise<void> {
  await unhideRecordSpaceRow(target)
  presentation.log(`unhidden ${target.note ?? target.message}`)
}

export async function recordSpaceHiddenCommand(presentation: Presentation): Promise<void> {
  for (const hidden of await listRecordSpaceHiddenRows())
    presentation.log(
      `${hidden.kind}\t${hidden.kind === 'note' ? hidden.label : hidden.id}\t${hidden.authorUserId ?? ''}\t${hidden.hiddenByUserId}\t${hidden.reason}\t${hidden.hiddenAt}`,
    )
}

export async function recordSpaceIntakeSetCommand(
  project: string,
  presentation: Presentation,
): Promise<void> {
  const intake = await setRecordSpaceOutsideIntake(project)
  presentation.log(`outside intake project ${intake.project}\t${intake.projectId}`)
}

export async function recordSpaceCreateCommand(
  name: string,
  slug: string,
  presentation: Presentation,
  trial = false,
): Promise<void> {
  const created = await createRecordSpace(name, slug, undefined, trial)
  presentation.log(`${created.id}\t${created.slug}`)
  for (const line of recordSpaceCreateReport(created.before, created.after, created)) {
    presentation.log(line)
  }
}

export async function recordSpaceDeleteTrialCommand(
  slug: string,
  presentation: Presentation,
): Promise<void> {
  const result = await deleteTrialSpace(slug)
  if (result.nothingToRemove) {
    presentation.log(`no space ${slug} among your spaces; nothing removed`)
    return
  }
  for (const account of result.neutralized)
    presentation.log(
      `neutralized\t${account.email}\tsessions ${account.sessions}\tmachine keys ${account.machineKeys}`,
    )
  for (const [table, count] of Object.entries(result.tables).filter(([, count]) => count > 0))
    presentation.log(`removed\t${table}\t${count}`)
  if (result.activeSpaceCleared)
    presentation.log(
      `active record space is now none; select one: ${PLATFORM_SLUG} record space switch <slug>`,
    )
}

export async function recordSpaceSwitchCommand(
  value: string,
  presentation: Presentation,
  names?: { shortName: string; displayName: string },
): Promise<void> {
  const selected = await switchRecordSpace(value, undefined, names)
  presentation.log(`active record space ${selected.slug}`)
}

export async function recordSpaceInviteCommand(
  email: string,
  role: string,
  space: string | undefined,
  presentation: Presentation,
): Promise<void> {
  const id = await inviteToRecordSpace(
    email,
    recordSpaceRole(role),
    await recordSpaceWriteDestination('record space invite', space),
  )
  presentation.log(id)
}

async function recordSpaceWriteDestination(
  verb: string,
  requested: string | undefined,
): Promise<string> {
  if (!requested) {
    const missing = recordSpaceOwnerDestination(verb, { space: requested }, [])
    if (missing.kind === 'refused') throw new Error(missing.remedy)
  }
  const identity = await recordMemberships()
  const destination = recordSpaceOwnerDestination(verb, { space: requested }, identity.memberships)
  if (destination.kind === 'refused') throw new Error(destination.remedy)
  if (destination.kind !== 'space') throw new Error('record space owner was not resolved')
  return destination.spaceId
}

export async function recordSpaceInvitationsCommand(presentation: Presentation): Promise<void> {
  for (const invitation of await pendingRecordInvitations()) {
    presentation.log(
      `${invitation.id}\t${invitation.spaceName}\t${invitation.spaceSlug}\t${invitation.role}\t${invitation.inviterEmail}\t${invitation.expiresAt}`,
    )
  }
}

export async function recordSpaceAcceptCommand(
  invitationId: string,
  presentation: Presentation,
  names?: { shortName: string; displayName: string },
): Promise<void> {
  const activeSpaceId = await acceptRecordInvitation(invitationId, undefined, names)
  presentation.log(`accepted record invitation ${invitationId}; active space ${activeSpaceId}`)
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
        `the next sync would target the old space until it is set; run \`${PLATFORM_SLUG} project set ${projectName} --settings '{"space":"${result.destinationSlug}"}'\``,
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
  let section: (typeof checks)[number]['section']
  for (const check of checks) {
    if (check.section === 'operator' && section !== 'operator') presentation.log('operator checks:')
    presentation.log(`${check.name}: ${check.status}${check.detail ? ` — ${check.detail}` : ''}`)
    section = check.section
  }
  presentation.exitCode?.(recordDoctorExitCode(checks))
}
