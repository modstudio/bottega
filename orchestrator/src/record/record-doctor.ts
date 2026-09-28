// concern: record-doctor
/** Diagnoses record connectivity, identity, migrations, ownership, and grants. */

import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import {
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { appliedRecordMigrationCount, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { machineId } from './machine-identity.ts'
import { quarantinedOutboxRows } from './outbox-quarantine.ts'
import { recordAttributionFailure } from './record-attribution.ts'
import { bearerHeaders, RECORD_SIGN_IN_REMEDY, recordAuth } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'
import { effectiveProjectSpace, refuseOwnerConnection } from './record-sync.ts'

type RecordDoctorStatus = 'pass' | 'fail' | 'skipped'
export type RecordDoctorCheck = {
  name: string
  status: RecordDoctorStatus
  detail?: string
}

export function recordDoctorExitCode(checks: readonly RecordDoctorCheck[]): 0 | 1 {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

export function outboxQuarantineCheck(database: Database): RecordDoctorCheck {
  const rows = quarantinedOutboxRows(database)
  return rows.length
    ? {
        name: 'outbox quarantine is empty',
        status: 'fail',
        detail: `${rows.length} quarantined: ${rows.map((row) => `${row.id} ${row.kind}`).join(', ')}; run \`orch record outbox retry <row-id>\` or \`orch record outbox retire <row-id> --reason <text>\``,
      }
    : { name: 'outbox quarantine is empty', status: 'pass' }
}

export function unattributedShare(missing: number, total: number): string {
  const percent = total === 0 ? 0 : (missing / total) * 100
  return `${missing}/${total} (${percent.toFixed(1)}%) unattributed`
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

function attributionResolutionCheck(failure: string | null): RecordDoctorCheck {
  return failure
    ? { name: 'last run attribution resolution', status: 'fail', detail: failure }
    : {
        name: 'last run attribution resolution',
        status: 'skipped',
        detail: 'no resolution failure recorded',
      }
}

function questionCountCheck(local: number, hosted: number): RecordDoctorCheck {
  if (local === hosted) {
    return { name: 'local versus hosted questions', status: 'pass', detail: `${local} each` }
  }
  return {
    name: 'local versus hosted questions',
    status: 'fail',
    detail: `${local} local; ${hosted} hosted`,
  }
}

export function localQuestionCountForSpace(
  database: Database,
  projects: Array<{ name: string; space: string | null }>,
  activeSpace: { id: string; slug: string },
): number {
  const projectSpaces = new Map(projects.map((project) => [project.name, project.space]))
  const rows = database
    .query<{ project: string | null }, []>(
      `SELECT COALESCE(run_project.name,cursor.project) AS project
         FROM question q
         LEFT JOIN run r ON r.id=q.run_id
         LEFT JOIN project run_project ON run_project.id=r.project_id
         LEFT JOIN workflow_cursor cursor ON cursor.id=q.workflow_cursor_id
        WHERE q.run_id IS NULL OR EXISTS (
          SELECT 1 FROM outbox o
           WHERE o.kind='run' AND o.record_id=r.record_id AND o.synced_at IS NOT NULL
        )`,
    )
    .all()
  return rows.filter((row) => {
    const space = row.project ? projectSpaces.get(row.project) : null
    const effectiveSpace = effectiveProjectSpace(space ?? null, activeSpace.id)
    return effectiveSpace === activeSpace.id || effectiveSpace === activeSpace.slug
  }).length
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
  checks.push(outboxQuarantineCheck(db()))
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

  checks.push(attributionResolutionCheck(recordAttributionFailure()))

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
      'runs with no started_by',
      'session intervals with no session identity',
      'local versus hosted questions',
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
      if (!current || !activeSpaceId) {
        skip('active space membership exists', 'active space unavailable')
        skip('runs with no started_by', 'active space unavailable')
        skip('session intervals with no session identity', 'active space unavailable')
        skip('local versus hosted questions', 'active space unavailable')
      } else {
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
        const attribution = await actor.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
          await tx`SELECT set_config('app.space_id', ${activeSpaceId}, true)`
          const runs = await tx`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE started_by_user_id IS NULL)::int AS missing
            FROM run WHERE space_id=${activeSpaceId}::uuid
          `
          const intervals = await tx`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE session_id IS NULL)::int AS missing
            FROM hub_interval WHERE space_id=${activeSpaceId}::uuid AND source='claude'
          `
          const questions = await tx`
            SELECT count(*)::int AS total FROM question
            WHERE space_id=${activeSpaceId}::uuid AND machine_id=${machineId()}::uuid
          `
          const spaces = await tx`SELECT slug FROM space WHERE id=${activeSpaceId}::uuid`
          return {
            runs: runs[0]!,
            intervals: intervals[0]!,
            questions: questions[0]!,
            activeSpaceSlug: String(spaces[0]?.slug ?? ''),
          }
        })
        checks.push({
          name: 'runs with no started_by',
          status: 'pass',
          detail: unattributedShare(
            Number(attribution.runs.missing),
            Number(attribution.runs.total),
          ),
        })
        const localQuestions = localQuestionCountForSpace(db(), input.projects ?? [], {
          id: activeSpaceId,
          slug: attribution.activeSpaceSlug,
        })
        const hostedQuestions = Number(attribution.questions.total)
        checks.push(questionCountCheck(localQuestions, hostedQuestions))
        checks.push({
          name: 'session intervals with no session identity',
          status: 'pass',
          detail: unattributedShare(
            Number(attribution.intervals.missing),
            Number(attribution.intervals.total),
          ),
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
