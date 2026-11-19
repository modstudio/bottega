// concern: record-cache-parity
/** Decides whether hosted document-cache rows are represented locally. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { recordApiClient } from './record-api-client.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordCacheSpaces } from './record-cache.ts'
import type { RecordCacheCounts } from './record-cache-counts-contract.ts'
import { recordCacheAddressOwner, recordCacheSpaceOwnsSubject } from './record-cache-ownership.ts'

type LocalCacheCounts = {
  byScope: Array<{ scope: string; docs: number }>
  subjects: number
}

export type RecordCacheParityInput = {
  space: string
  activeSpace: string
  projectSpaces: ReadonlyMap<string, string | null>
  local: LocalCacheCounts
  hosted?: RecordCacheCounts
  failure?: string
  failureRemedy?: string
}

export type RecordCacheParityDecision = {
  name: string
  status: 'pass' | 'fail'
  detail: string
  section: 'customer'
}

const pullRemedy = `run \`${PLATFORM_SLUG} record pull\``
const apiRemedy =
  'check BOTTEGA_RECORD_API_URL and make the hosted record API reachable, then retry'

function comparison(local: number, hosted: number): { label: string; gap: boolean } {
  if (local < hosted) return { label: 'missing locally', gap: true }
  if (local > hosted) return { label: 'extra locally', gap: false }
  return { label: 'ok', gap: false }
}

export function decideRecordCacheParity(input: RecordCacheParityInput): RecordCacheParityDecision {
  const name = `record cache parity: ${input.space}`
  if (input.failure)
    return {
      name,
      status: 'fail',
      detail: `could not establish: ${input.failure}; ${input.failureRemedy ?? apiRemedy}`,
      section: 'customer',
    }
  if (!input.hosted)
    return {
      name,
      status: 'fail',
      detail:
        'could not establish: hosted record API did not return the scope breakdown; deploy the current hosted record API, then retry',
      section: 'customer',
    }

  const localByScope = new Map(input.local.byScope.map((row) => [row.scope, row.docs]))
  const hostedByScope = new Map<string, number>()
  for (const row of input.hosted.byScope) {
    const owner = recordCacheAddressOwner({
      scope: row.scope,
      subject: row.project,
      activeSpaceId: input.activeSpace,
      projectSpaces: input.projectSpaces,
    })
    if (owner !== input.space) continue
    hostedByScope.set(row.scope, (hostedByScope.get(row.scope) ?? 0) + row.docs)
  }

  let gap = false
  const scopes = new Set([...localByScope.keys(), ...hostedByScope.keys()])
  const lines = [...scopes]
    .sort((left, right) => left.localeCompare(right))
    .map((scope) => {
      const local = localByScope.get(scope) ?? 0
      const hosted = hostedByScope.get(scope) ?? 0
      const result = comparison(local, hosted)
      gap ||= result.gap
      return `${scope}: ${local} local; ${hosted} hosted — ${result.label}`
    })
  const hostedSubjects = input.hosted.subjectsByProject.reduce(
    (total, row) =>
      recordCacheSpaceOwnsSubject(row.project, input.space, input.projectSpaces)
        ? total + row.subjects
        : total,
    0,
  )
  const subjectResult = comparison(input.local.subjects, hostedSubjects)
  gap ||= subjectResult.gap
  lines.push(
    `subjects: ${input.local.subjects} local; ${hostedSubjects} hosted — ${subjectResult.label}`,
  )
  if (gap) lines.push(pullRemedy)
  return { name, status: gap ? 'fail' : 'pass', detail: lines.join('\n'), section: 'customer' }
}

function isRecordCacheCounts(value: unknown): value is RecordCacheCounts {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<RecordCacheCounts>
  return (
    Array.isArray(response.byScope) &&
    response.byScope.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.scope === 'string' &&
        (row.project === null || typeof row.project === 'string') &&
        typeof row.docs === 'number' &&
        Number.isFinite(row.docs),
    ) &&
    Array.isArray(response.subjectsByProject) &&
    response.subjectsByProject.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.project === 'string' &&
        typeof row.subjects === 'number' &&
        Number.isFinite(row.subjects),
    )
  )
}

function localCacheCounts(local: Database, space: string): LocalCacheCounts {
  return {
    byScope: local
      .query<{ scope: string; docs: number }, [string]>(
        'SELECT scope,count(*) AS docs FROM doc WHERE space_id=? GROUP BY scope ORDER BY scope',
      )
      .all(space),
    subjects: local
      .query<{ subjects: number }, [string]>(
        'SELECT count(*) AS subjects FROM subject WHERE space_id=?',
      )
      .get(space)!.subjects,
  }
}

export async function recordCacheParityChecks(
  local: Database,
  identity: RecordIdentity,
): Promise<RecordCacheParityDecision[]> {
  const cache = recordCacheSpaces(identity, local)
  const client = recordApiClient()
  return Promise.all(
    cache.spaces.map(async (space) => {
      const base = {
        space,
        activeSpace: identity.activeSpaceId!,
        projectSpaces: cache.projectSpaces,
        local: localCacheCounts(local, space),
      }
      try {
        const response: unknown = await client.cacheCounts({
          destinationSpaceId: space,
        })
        return decideRecordCacheParity({
          ...base,
          hosted: isRecordCacheCounts(response) ? response : undefined,
        })
      } catch (error) {
        return decideRecordCacheParity({
          ...base,
          failure: error instanceof Error ? error.message : String(error),
          failureRemedy:
            error instanceof RecordApiRequestError && error.kind === 'refused'
              ? RECORD_SIGN_IN_REMEDY
              : undefined,
        })
      }
    }),
  )
}
