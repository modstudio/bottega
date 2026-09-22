// concern: record-runs
/** Owns tenant-bound record run reads. Must not know local run phases or CLI presentation. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { HOOK_TREE_JOB } from '../hook-tree/hook-tree.ts'

export type RecordCursor = { at: string; id: string }
type RecordScore = {
  runId?: string
  delivery: string
  quality: string | null
  fidelity: string | null
  scoredAt: string
  note?: string | null
  scoredBy?: string
  updatedAt?: string
}
export type RecordRun = {
  id: string
  spaceId: string
  spaceName: string
  projectName: string | null
  startedAt: string
  finishedAt: string | null
  agent: string
  job: string
  status: string
  latencyMs: number | null
  promptHead: string
  taskKey: string | null
  failureKind: string | null
  vendorTokens: number | null
  vendorCostUsd: number | null
  label: string | null
  lens: string | null
  parentRunId: string | null
  turn: number
  evidenceExcluded: string | null
  probe: boolean
  score: RecordScore | null
}
export type RecordRunDetail = RecordRun & Record<string, unknown> & { reviews: unknown[] }

type RunListInput = TenantPrincipal & {
  url: string
  limit: number
  before: RecordCursor | null
  project?: string
  agent?: string
  job?: string
  status?: string
}

export type RecordRunsWindowInput = TenantPrincipal & {
  url: string
  hours: 24 | 48 | 168 | 720
  agent: string
  project: string
  search: string
  offset: number
  limit: 25 | 50 | 100
  now?: Date
}

export type RecordRunsWindow = {
  items: RecordRun[]
  matched: number
  offset: number
  limit: number
  facets: { agents: string[]; projects: string[] }
  totals: { runs: number; scored: number; voided: number; failed: number }
  vendors: { agent: string; tokens: number; runs: number }[]
  unscored: number
  live: RecordRun[]
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())
const numeric = (value: unknown) => (value == null ? null : Number(value))
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
const presentation = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'bigint'
          ? Number(value)
          : value,
    ]),
  )

function runRow(row: Record<string, unknown>): RecordRun {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    spaceName: String(row.space_name),
    projectName: row.project_name == null ? null : String(row.project_name),
    startedAt: iso(row.started_at)!,
    finishedAt: iso(row.finished_at),
    agent: String(row.agent),
    job: String(row.job),
    status: String(row.status),
    latencyMs: numeric(row.latency_ms),
    promptHead: String(row.prompt_head),
    taskKey: row.task_key == null ? null : String(row.task_key),
    failureKind: row.failure_kind == null ? null : String(row.failure_kind),
    vendorTokens: numeric(row.vendor_tokens),
    vendorCostUsd: numeric(row.vendor_cost_usd),
    label: row.label == null ? null : String(row.label),
    lens: row.lens == null ? null : String(row.lens),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    turn: Number(row.turn),
    evidenceExcluded: row.evidence_excluded == null ? null : String(row.evidence_excluded),
    probe: Boolean(row.probe),
    score:
      row.delivery == null
        ? null
        : {
            delivery: String(row.delivery),
            quality: row.quality == null ? null : String(row.quality),
            fidelity: row.fidelity == null ? null : String(row.fidelity),
            scoredAt: iso(row.scored_at)!,
          },
  }
}

async function tenant<T>(input: { url: string } & TenantPrincipal, read: (tx: SQL) => Promise<T>) {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function listRecordRuns(input: RunListInput): Promise<RecordRun[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT r.id, r.space_id, sp.name AS space_name, p.name AS project_name,
        r.started_at, r.finished_at, r.agent, r.job,
        r.status, r.latency_ms, r.prompt_head, r.task_key, r.failure_kind, r.vendor_tokens,
        r.vendor_cost_usd, r.label, r.lens, r.parent_run_id, r.turn, r.evidence_excluded,
        r.probe, s.delivery, s.quality, s.fidelity, s.scored_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN project p ON p.id=r.project_id LEFT JOIN run_score s ON s.run_id=r.id
      WHERE (${input.before?.at ?? null}::timestamptz IS NULL OR (r.started_at, r.id) < (${input.before?.at ?? null}::timestamptz, ${input.before?.id ?? null}::uuid))
        AND (${input.project ?? null}::text IS NULL OR p.name=${input.project ?? null})
        AND (${input.agent ?? null}::text IS NULL OR r.agent=${input.agent ?? null})
        AND (${input.job ?? null}::text IS NULL OR r.job=${input.job ?? null})
        AND (${input.status ?? null}::text IS NULL OR r.status=${input.status ?? null})
      ORDER BY r.started_at DESC, r.id DESC LIMIT ${input.limit + 1}
    `
    return rows.map(runRow)
  })
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
}

function matchesWindowSearch(run: RecordRun, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return true
  return [run.agent, run.job, run.projectName, run.taskKey, run.lens, run.promptHead, run.status]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLocaleLowerCase().includes(query))
}

export function recordRunsWindow(
  windowRuns: RecordRun[],
  input: Pick<RecordRunsWindowInput, 'agent' | 'project' | 'search' | 'offset' | 'limit'>,
): RecordRunsWindow {
  const eligible = windowRuns.filter((run) => run.job !== HOOK_TREE_JOB)
  const facets = {
    agents: unique(eligible.map((run) => run.agent)),
    projects: unique(eligible.map((run) => run.projectName)),
  }
  const filtered = eligible.filter(
    (run) =>
      (!input.agent || run.agent === input.agent) &&
      (!input.project || run.projectName === input.project),
  )
  const searched = filtered.filter((run) => matchesWindowSearch(run, input.search))
  const scoreByRoot = new Map(
    eligible.filter((run) => run.score).map((run) => [run.id, run.score!] as const),
  )
  const newestTurnByRoot = new Map<string, string>()
  for (const run of eligible) {
    if (!run.parentRunId) continue
    const current = newestTurnByRoot.get(run.parentRunId)
    if (!current || current < run.startedAt) newestTurnByRoot.set(run.parentRunId, run.startedAt)
  }
  const totals = {
    runs: filtered.length,
    scored: filtered.filter(
      (run) =>
        run.score !== null &&
        run.evidenceExcluded === null &&
        !NOT_EVIDENCE.includes(run.failureKind as (typeof NOT_EVIDENCE)[number]),
    ).length,
    voided: filtered.filter((run) => run.evidenceExcluded !== null).length,
    failed: filtered.filter((run) => run.status === 'failed').length,
  }
  const unscored = filtered.filter((run) => {
    if (
      run.status !== 'ok' ||
      run.evidenceExcluded !== null ||
      run.probe ||
      run.parentRunId !== null
    )
      return false
    const score = scoreByRoot.get(run.id)
    const newestTurn = newestTurnByRoot.get(run.id)
    return !score || (newestTurn !== undefined && score.scoredAt < newestTurn)
  }).length
  const agentRuns = new Map<string, number>()
  const agentTokens = new Map<string, number>()
  for (const run of eligible) {
    agentRuns.set(run.agent, (agentRuns.get(run.agent) ?? 0) + 1)
    if (run.vendorTokens !== null)
      agentTokens.set(run.agent, (agentTokens.get(run.agent) ?? 0) + run.vendorTokens)
  }
  const vendors = [...agentTokens].map(([agent, tokens]) => ({
    agent,
    tokens,
    runs: agentRuns.get(agent) ?? 0,
  }))
  vendors.sort((left, right) => right.tokens - left.tokens || left.agent.localeCompare(right.agent))
  return {
    items: searched.slice(input.offset, input.offset + input.limit),
    matched: searched.length,
    offset: input.offset,
    limit: input.limit,
    facets,
    totals,
    vendors,
    unscored,
    live: searched.filter((run) => run.status === 'running'),
  }
}

export async function viewRecordRuns(input: RecordRunsWindowInput): Promise<RecordRunsWindow> {
  const since = new Date((input.now ?? new Date()).getTime() - input.hours * 60 * 60 * 1000)
  const windowRuns = await tenant(input, async (tx) => {
    const rows = await tx`
      SELECT r.id, r.space_id, sp.name AS space_name, p.name AS project_name,
        r.started_at, r.finished_at, r.agent, r.job, r.status, r.latency_ms,
        r.prompt_head, r.task_key, r.failure_kind, r.vendor_tokens, r.vendor_cost_usd,
        r.label, r.lens, r.parent_run_id, r.turn, r.evidence_excluded, r.probe,
        s.delivery, s.quality, s.fidelity, s.scored_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN project p ON p.id=r.project_id LEFT JOIN run_score s ON s.run_id=r.id
      WHERE r.started_at >= ${since}
      ORDER BY r.started_at DESC, r.id DESC
    `
    return rows.map(runRow)
  })
  return recordRunsWindow(windowRuns, input)
}

export async function getRecordRun(input: {
  url: string
  userId: string
  spaceId: string
  spaceIds?: string[]
  id: string
}): Promise<RecordRunDetail | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT r.*, sp.name AS space_name, p.name AS project_name,
        s.delivery, s.quality, s.fidelity, s.scored_at,
        s.note, s.scored_by, s.updated_at AS score_updated_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN project p ON p.id=r.project_id LEFT JOIN run_score s ON s.run_id=r.id
      WHERE r.id=${input.id}::uuid
    `
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    const base = runRow(row)
    if (base.score)
      Object.assign(base.score, {
        runId: String(row.id),
        note: row.note == null ? null : String(row.note),
        scoredBy: String(row.scored_by),
        updatedAt: iso(row.score_updated_at)!,
      })
    const lenses = await tx`
      SELECT l.*, rv.project_id AS review_project_id, rv.recorded_at, rv.completed_at,
        rv.tier, rv.patch_id, rv.commit_message,
        COALESCE(json_agg(f ORDER BY f.ordinal) FILTER (WHERE f.id IS NOT NULL), '[]') AS findings
      FROM review_lens l JOIN review rv ON rv.id=l.review_id LEFT JOIN review_finding f ON f.review_lens_id=l.id
      WHERE l.run_id=${input.id}::uuid GROUP BY l.id, rv.id ORDER BY rv.recorded_at DESC, l.id DESC
    `
    const detail = presentation(row)
    for (const key of [
      'delivery',
      'quality',
      'fidelity',
      'scoredAt',
      'note',
      'scoredBy',
      'scoreUpdatedAt',
    ])
      delete detail[key]
    return {
      ...detail,
      ...base,
      score: base.score,
      reviews: lenses.map((lens: Record<string, unknown>) => presentation(lens)),
    } as RecordRunDetail
  })
}
