import { SQL } from 'bun'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { VOID_EXCLUSION_REASON } from '../../src/verdict/verdict-rules.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const PROJECT_ID = '01990000-0000-7000-8000-000000000088'

type HostedExclusion = {
  rowReason: string | null
  supersededAt: string | null
  runReason: string | null
}

function hostedExclusionResult(
  source: string,
  hostedExclusion: HostedExclusion,
): Record<string, unknown>[] | null {
  if (source.includes('SELECT reason FROM run_exclusion') && source.includes('superseded_at')) {
    if (hostedExclusion.rowReason === null || hostedExclusion.supersededAt !== null) return []
    return [{ reason: hostedExclusion.rowReason }]
  }
  if (source.includes('SELECT evidence_excluded FROM run')) {
    return [{ evidence_excluded: hostedExclusion.runReason }]
  }
  return null
}

export type FakeRecordScore = {
  job: string
  writesRepo: boolean
  findings: boolean
  hostedAxes?: {
    delivery: string
    quality: string | null
    fidelity: string | null
  }
  onWrite?: () => void
}

export function fakePostgres(
  failFirstRun: false | Error = false,
  principal: string = RECORD_ACTOR_ROLE,
  score?: FakeRecordScore,
  hostedExclusion: HostedExclusion = {
    rowReason: VOID_EXCLUSION_REASON,
    supersededAt: null,
    runReason: VOID_EXCLUSION_REASON,
  },
  onRunWrite?: (ordinal: number) => void | Promise<void>,
  project: { id: string; name: string; spaceId?: string; retiredAt?: string | null } = {
    id: PROJECT_ID,
    name: PLATFORM_NAME,
  },
): {
  sql: SQL
  statements: string[]
  parameters: unknown[][]
  transactionSpaceIds: string[]
} {
  const statements: string[] = []
  const parameters: unknown[][] = []
  let failed = false
  let transaction = -1
  let scoreWritten = false
  let runWrites = 0
  let runReferenceAvailable = true
  const transactionSpaceIds: string[] = []
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const source = parts.join('?')
    statements.push(source)
    if (source.includes("set_config('app.space_id'")) {
      transactionSpaceIds[transaction] = String(values[0])
    }
    if (source.includes('SELECT job, failure_kind, machine_id FROM run')) {
      return [
        {
          job: score?.job ?? 'file-question',
          failure_kind: null,
          machine_id: MACHINE_ID,
        },
      ]
    }
    if (source.includes('SELECT delivery, quality, fidelity FROM run_score')) {
      return score?.hostedAxes ? [score.hostedAxes] : []
    }
    if (source.includes("snapshot.kind='jobs'")) {
      return score
        ? [
            {
              item: {
                name: score.job,
                needs: { writesRepo: score.writesRepo },
                findings: score.findings,
              },
            },
          ]
        : []
    }
    if (source.includes('information_schema.columns')) {
      return [
        { column_name: 'superseded_at' },
        { column_name: 'superseded_by' },
        { column_name: 'supersede_note' },
      ]
    }
    const exclusionResult = hostedExclusionResult(source, hostedExclusion)
    if (exclusionResult) return exclusionResult
    if (source.includes('SELECT reason FROM run_exclusion')) return []
    if (source.includes('INSERT INTO machine')) return [{ user_id: values[1] }]
    if (source.includes('SELECT user_id FROM machine')) return [{ user_id: values[0] }]
    return source.includes('FROM project')
      ? [
          {
            id: project.id,
            name: project.name,
            space_id: project.spaceId ?? transactionSpaceIds[transaction],
            retired_at: project.retiredAt ?? null,
          },
        ]
      : []
  }) as unknown as SQL
  tx.options = {} as SQL['options']
  tx.unsafe = ((source: string, values?: unknown[]) => {
    const operation = (async (): Promise<Record<string, unknown>[]> => {
      statements.push(source)
      parameters.push(values ?? [])
      if (source.includes('owned_reference'))
        return runReferenceAvailable ? [{ id: values?.[0] }] : []
      if (source.toLowerCase().includes('insert into "run"')) {
        runWrites++
        await onRunWrite?.(runWrites)
      }
      if (failFirstRun && !failed && source.toLowerCase().includes('insert into "run"')) {
        failed = true
        runReferenceAvailable = false
        throw failFirstRun
      }
      if (source.toLowerCase().includes('insert into "run"')) runReferenceAvailable = true
      if (
        !runReferenceAvailable &&
        source.toLowerCase().includes('insert into') &&
        source.toLowerCase().includes('returning')
      ) {
        return []
      }
      if (!scoreWritten && source.toLowerCase().includes('insert into "run_score"')) {
        scoreWritten = true
        score?.onWrite?.()
      }
      if (
        source.toLowerCase().includes('insert into') &&
        source.toLowerCase().includes('returning')
      ) {
        return [{ id: values?.[0] }]
      }
      return []
    })() as Promise<Record<string, unknown>[]> & {
      values(): Promise<unknown[][]>
    }
    operation.values = async () => (await operation).map((row) => Object.values(row))
    return operation
  }) as SQL['unsafe']
  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      statements.push(parts.join('?'))
      return [{ principal }]
    },
    {
      begin: async (operation: (client: SQL) => unknown) => {
        transaction++
        return operation(tx)
      },
      close: async () => {},
    },
  ) as unknown as SQL
  return { sql, statements, parameters, transactionSpaceIds }
}

export const serverError = (message: string, errno: number) =>
  new SQL.PostgresError(message, {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: errno as unknown as string,
  })
