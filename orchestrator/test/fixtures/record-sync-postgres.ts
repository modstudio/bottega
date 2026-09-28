import { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'

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
    rowReason: 'voided with orch score --void',
    supersededAt: null,
    runReason: 'voided with orch score --void',
  },
  onRunWrite?: (ordinal: number) => void | Promise<void>,
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
  const transactionSpaceIds: string[] = []
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const source = parts.join('?')
    statements.push(source)
    if (source.includes("set_config('app.space_id'")) {
      transactionSpaceIds[transaction] = String(values[0])
    }
    if (source.includes('SELECT job, failure_kind, machine_id FROM run')) {
      return [{ job: score?.job ?? 'file-question', failure_kind: null, machine_id: MACHINE_ID }]
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
    return source.includes('SELECT id FROM project') ? [{ id: PROJECT_ID }] : []
  }) as unknown as SQL
  tx.options = {} as SQL['options']
  tx.unsafe = (async (source: string, values?: unknown[]) => {
    statements.push(source)
    parameters.push(values ?? [])
    if (source.toLowerCase().includes('insert into "run"')) {
      runWrites++
      await onRunWrite?.(runWrites)
    }
    if (failFirstRun && !failed && source.toLowerCase().includes('insert into "run"')) {
      failed = true
      throw failFirstRun
    }
    if (!scoreWritten && source.toLowerCase().includes('insert into "run_score"')) {
      scoreWritten = true
      score?.onWrite?.()
    }
    return []
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
