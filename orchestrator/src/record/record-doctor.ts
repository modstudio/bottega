// concern: record-doctor
/** Diagnoses record connectivity, identity, migrations, ownership, and grants. */

import { SQL } from 'bun'
import {
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../../shared/record/schema.ts'
import { appliedRecordMigrationCount, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { bearerHeaders, RECORD_SIGN_IN_REMEDY, recordAuth } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'
import { refuseOwnerConnection } from './record-sync.ts'

type RecordDoctorStatus = 'pass' | 'fail' | 'skipped'
export type RecordDoctorCheck = {
  name: string
  status: RecordDoctorStatus
  detail?: string
}

export function recordDoctorExitCode(checks: readonly RecordDoctorCheck[]): 0 | 1 {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

export function redactRecordPasswords(value: string, urls: readonly string[]): string {
  let redacted = value.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1***@')
  for (const valueUrl of urls) {
    try {
      const password = new URL(valueUrl).password
      if (password) redacted = redacted.split(password).join('***')
    } catch {
      // An invalid URL is reported by the connection check; it has no safely parseable password.
    }
  }
  return redacted
}

function failureDetail(error: unknown, urls: readonly string[]): string {
  return redactRecordPasswords(error instanceof Error ? error.message : String(error), urls)
}

async function declaredProjectSpaceChecks(
  actor: SQL,
  current: { user: { id: string } } | undefined,
  activeSpaceId: string | null | undefined,
  projects: Array<{ name: string; space: string | null }>,
): Promise<RecordDoctorCheck[]> {
  if (!current) return []
  const memberships = await actor.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
    await tx`SELECT set_config('app.space_id', ${activeSpaceId ?? ''}, true)`
    return tx`
      SELECT m.space_id, s.slug FROM membership m JOIN space s ON s.id=m.space_id
      WHERE m.user_id=${current.user.id}::uuid
    `
  })
  return projects.flatMap((project) => {
    if (!project.space) return []
    const reachable = memberships.find(
      (membership: Record<string, unknown>) =>
        String(membership.slug) === project.space || String(membership.space_id) === project.space,
    )
    return [
      reachable
        ? {
            name: `project ${project.name} declared space`,
            status: 'pass' as const,
            detail: `${String(reachable.slug)} (${String(reachable.space_id)})`,
          }
        : {
            name: `project ${project.name} declared space`,
            status: 'fail' as const,
            detail: `${project.space} is not reachable by the signed-in user; join it with an invitation`,
          },
    ]
  })
}

export async function diagnoseRecord(
  input: {
    recordUrl?: string
    migrateUrl?: string
    projects?: Array<{ name: string; space: string | null }>
  } = {},
): Promise<RecordDoctorCheck[]> {
  const recordUrl = input.recordUrl ?? process.env.ORCH_RECORD_URL
  const migrateUrl = input.migrateUrl ?? process.env.ORCH_RECORD_MIGRATE_URL
  const urls = [recordUrl, migrateUrl].filter((url): url is string => Boolean(url))
  const checks: RecordDoctorCheck[] = []
  const run = async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await action()
      checks.push({ name, status: 'pass' })
      return result
    } catch (error) {
      checks.push({ name, status: 'fail', detail: failureDetail(error, urls) })
    }
  }
  const skip = (name: string, detail: string) => checks.push({ name, status: 'skipped', detail })

  if (recordUrl) checks.push({ name: 'ORCH_RECORD_URL set', status: 'pass' })
  else
    checks.push({ name: 'ORCH_RECORD_URL set', status: 'fail', detail: 'ORCH_RECORD_URL not set' })

  if (!recordUrl) {
    for (const name of [
      'record connection works',
      'record connection is not record_owner',
      'stored session exists and is valid',
      'active space exists',
      'active space membership exists',
    ])
      skip(name, 'ORCH_RECORD_URL not set')
  } else {
    const actor = new SQL(recordUrl)
    await run('record connection works', async () => {
      await actor`SELECT 1`
    })
    await run('record connection is not record_owner', () => refuseOwnerConnection(actor, 'doctor'))
    try {
      const token = storedRecordToken()
      const current = await run('stored session exists and is valid', async () => {
        if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
        const session = await recordAuth(recordUrl).api.getSession({
          headers: bearerHeaders(token),
        })
        if (!session) throw new Error(RECORD_SIGN_IN_REMEDY)
        return session
      })
      const activeSpaceId = current?.session.activeOrganizationId
      if (activeSpaceId) checks.push({ name: 'active space exists', status: 'pass' })
      else
        checks.push({
          name: 'active space exists',
          status: 'fail',
          detail: 'record session has no active space',
        })
      if (!current || !activeSpaceId)
        skip('active space membership exists', 'active space unavailable')
      else {
        await run('active space membership exists', async () => {
          const memberships = await actor.begin(async (tx) => {
            await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
            await tx`SELECT set_config('app.space_id', ${activeSpaceId}, true)`
            return tx`
              SELECT 1 FROM membership
              WHERE user_id=${current.user.id}::uuid AND space_id=${activeSpaceId}::uuid
            `
          })
          if (memberships.length !== 1)
            throw new Error('signed-in user is not a member of the active space')
        })
      }
      checks.push(
        ...(await declaredProjectSpaceChecks(actor, current, activeSpaceId, input.projects ?? [])),
      )
    } finally {
      await actor.close()
    }
  }

  const ownerChecks = [
    'record roles exist',
    'schema public owned by record_owner',
    'applied migrations equal shipped migrations',
    'record_actor representative grants',
  ]
  if (!migrateUrl) {
    for (const name of ownerChecks) skip(name, 'ORCH_RECORD_MIGRATE_URL not set')
    return checks
  }
  const owner = new SQL(migrateUrl)
  try {
    await run(ownerChecks[0]!, async () => {
      const rows = await owner`
        SELECT rolname FROM pg_roles
        WHERE rolname IN (${RECORD_OWNER_ROLE},${RECORD_ACTOR_ROLE},${RECORD_READER_ROLE})
      `
      if (rows.length !== 3) throw new Error('one or more record roles are absent')
    })
    await run(ownerChecks[1]!, async () => {
      const rows = await owner`
        SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'
      `
      if (rows[0]?.owner !== RECORD_OWNER_ROLE) {
        throw new Error(`schema public is not owned by ${RECORD_OWNER_ROLE}`)
      }
    })
    await run(ownerChecks[2]!, async () => {
      const applied = await appliedRecordMigrationCount(migrateUrl)
      const shipped = recordMigrationCount()
      if (applied !== shipped) throw new Error(`applied ${applied}; shipped ${shipped}`)
    })
    await run(ownerChecks[3]!, async () => {
      const rows = await owner`
        SELECT
          CASE table_name WHEN '"user"' THEN 'user' ELSE table_name END AS table_name,
          privilege
        FROM (VALUES
          ('project', 'SELECT'),
          ('project', 'INSERT'),
          ('project', 'UPDATE'),
          ('project', 'DELETE'),
          ('invitation', 'SELECT'),
          ('invitation', 'INSERT'),
          ('invitation', 'UPDATE'),
          ('invitation', 'DELETE'),
          ('"user"', 'SELECT'),
          ('"user"', 'INSERT'),
          ('"user"', 'UPDATE')
        ) AS required(table_name, privilege)
        WHERE NOT has_table_privilege(${RECORD_ACTOR_ROLE}, table_name, privilege)
        ORDER BY table_name, privilege
      `
      if (rows.length) {
        const missing = rows.map((row: Record<string, unknown>) => {
          return `${String(row.table_name)} ${String(row.privilege)}`
        })
        throw new Error(missing.join(', '))
      }
    })
  } finally {
    await owner.close()
  }
  return checks
}
