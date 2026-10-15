// concern: record-doctor
/** Diagnoses customer record access through the hosted API and optional operator connections. */

import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../../../shared/record/schema.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import {
  RECORD_ACTIVE_SPACE_REMEDY,
  RECORD_SIGN_IN_REMEDY,
} from '../../../shared/record-remedies.ts'
import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { db } from '../database/db.ts'
import { appliedRecordMigrationCount, recordMigrationCount } from '../postgres/postgres-migrate.ts'
import { machineId } from './machine-identity.ts'
import { quarantinedOutboxRows } from './outbox-quarantine.ts'
import { RecordApiRequestError, recordApiClient } from './record-api-client.ts'
import { recordAttributionFailure } from './record-attribution.ts'
import { effectiveProjectSpace } from './record-project-destination.ts'
import { storedRecordToken } from './record-session.ts'

async function refuseOwnerConnection(postgres: SQL, operation: string): Promise<void> {
  const principals = await postgres`SELECT current_user AS principal`
  if (principals[0]?.principal === RECORD_OWNER_ROLE)
    throw new Error(
      `record ${operation} refuses ${RECORD_OWNER_ROLE} credentials; set ORCH_RECORD_URL to the ${RECORD_ACTOR_ROLE} connection`,
    )
}

type RecordDoctorStatus = 'pass' | 'fail' | 'skipped'
export type RecordDoctorCheck = {
  name: string
  status: RecordDoctorStatus
  detail?: string
  section?: 'customer' | 'operator'
}
type QuarantinedDoctorRow = { id: number; kind: string; reason: string }
export type RecordDoctorFacts = {
  apiConfigured: boolean
  apiReachable: boolean
  apiFailure?: string
  sessionAccepted: boolean
  sessionFailure?: string
  attributionFailure: string | null
  activeSpaceId: string | null
  memberships: readonly RecordSpaceMembership[]
  projects: ReadonlyArray<{ name: string; space: string | null }>
  pendingOutboxRows: number
  quarantinedOutboxRows: readonly QuarantinedDoctorRow[]
  operatorConnectionPresent: boolean
  operatorChecks?: readonly RecordDoctorCheck[]
}

const API_CONFIGURATION_REMEDY = 'set ORCH_RECORD_API_URL to the hosted record API address'
const API_REACHABILITY_REMEDY =
  'check ORCH_RECORD_API_URL and make the hosted record API reachable, then retry'

export function recordDoctorExitCode(checks: readonly RecordDoctorCheck[]): 0 | 1 {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

function attributionFailureCheck(failure: string | null): RecordDoctorCheck {
  if (!failure)
    return {
      name: 'last run attribution resolution',
      status: 'pass',
      section: 'customer',
    }
  const remedy = failure.startsWith('stored record session:')
    ? RECORD_SIGN_IN_REMEDY
    : API_REACHABILITY_REMEDY
  return {
    name: 'last run attribution resolution',
    status: 'fail',
    detail: `${failure}; ${remedy}`,
    section: 'customer',
  }
}

function membershipChecks(facts: RecordDoctorFacts): RecordDoctorCheck[] {
  if (!facts.sessionAccepted)
    return [
      {
        name: 'user memberships',
        status: 'fail',
        detail: RECORD_SIGN_IN_REMEDY,
        section: 'customer',
      },
    ]
  if (!facts.memberships.length)
    return [
      {
        name: 'user memberships',
        status: 'fail',
        detail: 'the signed-in user has no record space membership; join one with an invitation',
        section: 'customer',
      },
    ]
  return facts.memberships.map((membership) => ({
    name: `membership ${membership.slug}`,
    status: 'pass',
    detail: `${membership.permission} (${membership.spaceId})`,
    section: 'customer',
  }))
}

function projectSpaceChecks(facts: RecordDoctorFacts): RecordDoctorCheck[] {
  if (!facts.sessionAccepted) return []
  return facts.projects.flatMap((project) => {
    if (!project.space) return []
    const membership = recordSpaceMembership(project.space, facts.memberships)
    return [
      membership
        ? {
            name: `project ${project.name} declared space`,
            status: 'pass' as const,
            detail: `${membership.slug}: ${membership.permission}`,
            section: 'customer' as const,
          }
        : {
            name: `project ${project.name} declared space`,
            status: 'fail' as const,
            detail: `${project.space} is not one of the signed-in user's memberships; join it with an invitation`,
            section: 'customer' as const,
          },
    ]
  })
}

/** Turns already gathered facts into the complete, ordered doctor presentation. */
export function decideRecordDoctorChecks(facts: RecordDoctorFacts): RecordDoctorCheck[] {
  const checks: RecordDoctorCheck[] = [
    facts.apiConfigured
      ? {
          name: 'hosted API address configured',
          status: 'pass',
          section: 'customer',
        }
      : {
          name: 'hosted API address configured',
          status: 'fail',
          detail: API_CONFIGURATION_REMEDY,
          section: 'customer',
        },
    facts.apiReachable
      ? { name: 'hosted API reachable', status: 'pass', section: 'customer' }
      : {
          name: 'hosted API reachable',
          status: 'fail',
          detail: facts.apiFailure ?? API_REACHABILITY_REMEDY,
          section: 'customer',
        },
    facts.sessionAccepted
      ? { name: 'stored session accepted', status: 'pass', section: 'customer' }
      : {
          name: 'stored session accepted',
          status: 'fail',
          detail: facts.sessionFailure ?? RECORD_SIGN_IN_REMEDY,
          section: 'customer',
        },
  ]
  const active = facts.memberships.find((membership) => membership.spaceId === facts.activeSpaceId)
  checks.push(attributionFailureCheck(facts.attributionFailure))
  checks.push(
    active
      ? {
          name: 'session active space',
          status: 'pass',
          detail: `${active.slug} (${active.spaceId})`,
          section: 'customer',
        }
      : {
          name: 'session active space',
          status: 'fail',
          detail: facts.sessionAccepted ? RECORD_ACTIVE_SPACE_REMEDY : RECORD_SIGN_IN_REMEDY,
          section: 'customer',
        },
  )

  checks.push(...membershipChecks(facts), ...projectSpaceChecks(facts))
  checks.push({
    name: 'local outbox pending rows',
    status: 'pass',
    detail: String(facts.pendingOutboxRows),
    section: 'customer',
  })
  checks.push(
    facts.quarantinedOutboxRows.length
      ? {
          name: 'local outbox quarantined rows',
          status: 'fail',
          detail: `${facts.quarantinedOutboxRows.length}: ${facts.quarantinedOutboxRows.map((row) => `${row.id} ${row.kind} (${row.reason})`).join(', ')}; run \`${PLATFORM_SLUG} record outbox retry <row-id>\` or \`${PLATFORM_SLUG} record outbox retire <row-id> --reason <text>\``,
          section: 'customer',
        }
      : {
          name: 'local outbox quarantined rows',
          status: 'pass',
          detail: '0',
          section: 'customer',
        },
  )

  if (facts.operatorConnectionPresent)
    checks.push(
      ...(facts.operatorChecks ?? []).map((check) => ({
        ...check,
        section: 'operator' as const,
      })),
    )
  return checks
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

function questionCountCheck(name: string, local: number, hosted: number): RecordDoctorCheck {
  return local === hosted
    ? { name, status: 'pass', detail: `${local} each` }
    : {
        name,
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
         WHERE o.kind='run' AND o.row_id=r.record_id AND o.synced_at IS NOT NULL
      )`,
    )
    .all()
  return rows.filter((row) => {
    const space = row.project ? projectSpaces.get(row.project) : null
    const effectiveSpace = effectiveProjectSpace(space ?? null, activeSpace.id)
    return effectiveSpace === activeSpace.id || effectiveSpace === activeSpace.slug
  }).length
}

function pendingOutboxCount(database: Database): number {
  return database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM outbox
     WHERE synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
    )
    .get()!.count
}

type CustomerFacts = Omit<RecordDoctorFacts, 'operatorConnectionPresent' | 'operatorChecks'> & {
  userId: string | null
}

async function customerFacts(
  projects: Array<{ name: string; space: string | null }>,
  database: Database,
): Promise<CustomerFacts> {
  const apiConfigured = Boolean(resolveRecordApiUrl()?.trim())
  // Doctor is observational: legacy session migration is left to sign-in and other write paths.
  const token = storedRecordToken(database, undefined, false)
  let apiReachable = false
  let sessionAccepted = false
  let apiFailure: string | undefined
  let sessionFailure: string | undefined
  let identity: Awaited<ReturnType<ReturnType<typeof recordApiClient>['whoami']>> | null = null
  if (!apiConfigured) {
    apiFailure = API_CONFIGURATION_REMEDY
    sessionFailure = RECORD_SIGN_IN_REMEDY
  } else if (!token) {
    apiFailure = `reachability requires a stored session; ${RECORD_SIGN_IN_REMEDY}`
    sessionFailure = RECORD_SIGN_IN_REMEDY
  } else {
    try {
      identity = await recordApiClient().whoami()
      apiReachable = true
      sessionAccepted = true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof RecordApiRequestError && error.kind === 'refused') {
        apiReachable = true
        sessionFailure = detail
      } else {
        apiFailure = `${detail}; ${API_REACHABILITY_REMEDY}`
        sessionFailure = RECORD_SIGN_IN_REMEDY
      }
    }
  }
  return {
    apiConfigured,
    apiReachable,
    apiFailure,
    sessionAccepted,
    sessionFailure,
    attributionFailure: recordAttributionFailure(database),
    userId: identity?.user.id ?? null,
    activeSpaceId: identity?.activeSpaceId ?? null,
    memberships: parseRecordSpaceMemberships(identity?.memberships),
    projects,
    pendingOutboxRows: pendingOutboxCount(database),
    quarantinedOutboxRows: quarantinedOutboxRows(database).map((row) => ({
      id: row.id,
      kind: row.kind,
      reason: row.error,
    })),
  }
}

async function operatorRecordChecks(input: {
  recordUrl: string
  migrateUrl?: string
  identity: {
    userId: string
    activeSpaceId: string
    activeSpaceSlug: string
  } | null
  projects: Array<{ name: string; space: string | null }>
  database: Database
}): Promise<RecordDoctorCheck[]> {
  const urls = [input.recordUrl, input.migrateUrl].filter((url): url is string => Boolean(url))
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
  const actor = new SQL(input.recordUrl)
  const identityNames = [
    'runs with no started_by',
    'local versus hosted questions',
    'session intervals with no session identity',
  ] as const
  try {
    const connected = await run('record connection works', async () => {
      await actor`SELECT 1`
      return true
    })
    await run('record connection is not record_owner', () => refuseOwnerConnection(actor, 'doctor'))
    if (!connected || !input.identity) {
      const detail = connected
        ? 'accepted active session unavailable'
        : 'record connection unavailable'
      for (const name of identityNames) checks.push({ name, status: 'skipped', detail })
    } else {
      const identity = input.identity
      try {
        const attribution = await actor.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${identity.userId}, true)`
          await tx`SELECT set_config('app.space_id', ${identity.activeSpaceId}, true)`
          const runs =
            await tx`SELECT count(*)::int AS total, count(*) FILTER (WHERE started_by_user_id IS NULL)::int AS missing FROM run WHERE space_id=${identity.activeSpaceId}::uuid`
          const intervals =
            await tx`SELECT count(*)::int AS total, count(*) FILTER (WHERE session_id IS NULL)::int AS missing FROM hub_interval WHERE space_id=${identity.activeSpaceId}::uuid AND source='claude'`
          const questions =
            await tx`SELECT count(*)::int AS total FROM question WHERE space_id=${identity.activeSpaceId}::uuid AND machine_id=${machineId()}::uuid`
          return {
            runs: runs[0]!,
            intervals: intervals[0]!,
            questions: questions[0]!,
          }
        })
        checks.push({
          name: identityNames[0],
          status: 'pass',
          detail: unattributedShare(
            Number(attribution.runs.missing),
            Number(attribution.runs.total),
          ),
        })
        checks.push(
          questionCountCheck(
            identityNames[1],
            localQuestionCountForSpace(input.database, input.projects, {
              id: identity.activeSpaceId,
              slug: identity.activeSpaceSlug,
            }),
            Number(attribution.questions.total),
          ),
        )
        checks.push({
          name: identityNames[2],
          status: 'pass',
          detail: unattributedShare(
            Number(attribution.intervals.missing),
            Number(attribution.intervals.total),
          ),
        })
      } catch (error) {
        const detail = failureDetail(error, urls)
        for (const name of identityNames) checks.push({ name, status: 'fail', detail })
      }
    }
  } finally {
    await actor.close()
  }

  const ownerNames = [
    'record roles exist',
    'schema public owned by record_owner',
    'applied migrations equal shipped migrations',
    'record_actor representative grants',
  ]
  if (!input.migrateUrl) {
    for (const name of ownerNames)
      checks.push({
        name,
        status: 'skipped',
        detail: 'ORCH_RECORD_MIGRATE_URL not set',
      })
    return checks
  }
  const owner = new SQL(input.migrateUrl)
  try {
    await run(ownerNames[0]!, async () => {
      const rows =
        await owner`SELECT rolname FROM pg_roles WHERE rolname IN (${RECORD_OWNER_ROLE},${RECORD_ACTOR_ROLE},${RECORD_READER_ROLE})`
      if (rows.length !== 3) throw new Error('one or more record roles are absent')
    })
    await run(ownerNames[1]!, async () => {
      const rows =
        await owner`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'`
      if (rows[0]?.owner !== RECORD_OWNER_ROLE)
        throw new Error(`schema public is not owned by ${RECORD_OWNER_ROLE}`)
    })
    await run(ownerNames[2]!, async () => {
      const applied = await appliedRecordMigrationCount(input.migrateUrl!)
      const shipped = recordMigrationCount()
      if (applied !== shipped) throw new Error(`applied ${applied}; shipped ${shipped}`)
    })
    await run(ownerNames[3]!, async () => {
      const rows = await owner`
        SELECT CASE table_name WHEN '"user"' THEN 'user' ELSE table_name END AS table_name, privilege
        FROM (VALUES
          ('project', 'SELECT'), ('project', 'INSERT'), ('project', 'UPDATE'), ('project', 'DELETE'),
          ('invitation', 'SELECT'), ('invitation', 'INSERT'), ('invitation', 'UPDATE'), ('invitation', 'DELETE'),
          ('"user"', 'SELECT'), ('"user"', 'INSERT'), ('"user"', 'UPDATE')
        ) AS required(table_name, privilege)
        WHERE NOT has_table_privilege(${RECORD_ACTOR_ROLE}, table_name, privilege)
        ORDER BY table_name, privilege`
      if (rows.length)
        throw new Error(
          rows
            .map(
              (row: Record<string, unknown>) =>
                `${String(row.table_name)} ${String(row.privilege)}`,
            )
            .join(', '),
        )
    })
  } finally {
    await owner.close()
  }
  return checks
}

export async function diagnoseRecord(
  input: {
    recordUrl?: string
    migrateUrl?: string
    projects?: Array<{ name: string; space: string | null }>
  } = {},
): Promise<RecordDoctorCheck[]> {
  const database = db()
  const projects = input.projects ?? []
  const customer = await customerFacts(projects, database)
  const recordUrl = input.recordUrl ?? process.env.ORCH_RECORD_URL
  let operatorChecks: RecordDoctorCheck[] | undefined
  if (recordUrl) {
    const active = customer.memberships.find(
      (membership) => membership.spaceId === customer.activeSpaceId,
    )
    const identity =
      customer.sessionAccepted && customer.userId && customer.activeSpaceId && active
        ? {
            userId: customer.userId,
            activeSpaceId: customer.activeSpaceId,
            activeSpaceSlug: active.slug,
          }
        : null
    operatorChecks = await operatorRecordChecks({
      recordUrl,
      migrateUrl: input.migrateUrl ?? process.env.ORCH_RECORD_MIGRATE_URL,
      identity,
      projects,
      database,
    })
  }
  const { userId: _userId, ...customerDecisionFacts } = customer
  return decideRecordDoctorChecks({
    ...customerDecisionFacts,
    operatorConnectionPresent: Boolean(recordUrl),
    operatorChecks,
  })
}
