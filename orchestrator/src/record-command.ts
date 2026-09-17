// concern: record-command
/** Presents record migration, space, invitation, and doctor operations. */

import {
  appliedRecordMigrationCount,
  migratePostgres,
  recordMigrationCount,
} from './postgres/postgres-migrate.ts'
import { diagnoseRecord, recordDoctorExitCode, redactRecordPasswords } from './record-doctor.ts'
import {
  acceptRecordInvitation,
  inviteToActiveRecordSpace,
  pendingRecordInvitations,
  recordMemberships,
  recordSpaceRole,
  switchRecordSpace,
} from './record-space.ts'

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
    throw new Error(redactRecordPasswords(message, [url]))
  }
  presentation.log(
    `record migrations applied before ${before}; after ${after}; shipped ${recordMigrationCount()}`,
  )
}

export async function recordSpaceListCommand(presentation: Presentation): Promise<void> {
  const result = await recordMemberships(recordUrl())
  for (const membership of result.memberships) {
    presentation.log(
      `${membership.spaceId === result.activeSpaceId ? '* ' : '  '}${membership.slug}\t${membership.name}\t${membership.role}\t${membership.permission}`,
    )
  }
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

export async function recordDoctorCommand(presentation: Presentation): Promise<void> {
  const checks = await diagnoseRecord()
  for (const check of checks) {
    presentation.log(`${check.name}: ${check.status}${check.detail ? ` — ${check.detail}` : ''}`)
  }
  presentation.exitCode?.(recordDoctorExitCode(checks))
}
