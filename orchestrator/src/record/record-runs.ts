// concern: record-runs
/** Owns tenant-bound record run reads. Must not know local run phases or CLI presentation. */
import { SQL } from 'bun'
import { crossMachineLabel, type MachineRef } from '../../../shared/machine-label.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RunDetailReviewLens } from '../../../shared/review-presentation.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { HOOK_TREE_JOB } from '../hook-tree/hook-tree.ts'
import type { RecordCursor } from './record-cursor.ts'
import { recordMachine } from './record-machine.ts'
import { recordPresentation, reviewLensPresentation } from './review-presentation.ts'

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
  number: number | null
  machine: MachineRef
  machineLabel: string | null
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
  modelCalls: number | null
  peakCallTokens: number | null
  quotaUsedPercentStart: number | null
  quotaUsedPercentEnd: number | null
  quotaWindowMinutes: number | null
  quotaResetsAt: number | null
  vendorCostUsd: number | null
  vendorInputTokens: number | null
  vendorOutputTokens: number | null
  vendorEstimatedCostUsd: number | null
  vendorCostSource: string | null
  label: string | null
  lens: string | null
  parentRunId: string | null
  turn: number
  evidenceExcluded: string | null
  probe: boolean
  score: RecordScore | null
}
export type RecordRunDetail = RecordRun &
  Record<string, unknown> & {
    reviews: RunDetailReviewLens[]
  }

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
  vendors: { agent: string; tokens: number | null; runs: number }[]
  unscored: number
  live: RecordRun[]
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())
const numeric = (value: unknown) => (value == null ? null : Number(value))
function runMachineLabel(number: number | null, machine: RecordRun['machine']): string | null {
  return number === null ? null : crossMachineLabel('run', number, machine)
}
export function runRow(row: Record<string, unknown>): RecordRun {
  const number = numeric(row.number)
  const machine = recordMachine(row)
  return {
    id: String(row.id),
    number,
    machine,
    machineLabel: runMachineLabel(number, machine),
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
    modelCalls: numeric(row.model_calls),
    peakCallTokens: numeric(row.peak_call_tokens),
    quotaUsedPercentStart: numeric(row.quota_used_percent_start),
    quotaUsedPercentEnd: numeric(row.quota_used_percent_end),
    quotaWindowMinutes: numeric(row.quota_window_minutes),
    quotaResetsAt: numeric(row.quota_resets_at),
    vendorCostUsd: numeric(row.vendor_cost_usd),
    vendorInputTokens: numeric(row.vendor_input_tokens),
    vendorOutputTokens: numeric(row.vendor_output_tokens),
    vendorEstimatedCostUsd: numeric(row.vendor_estimated_cost_usd),
    vendorCostSource: row.vendor_cost_source == null ? null : String(row.vendor_cost_source),
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
      SELECT r.id, r.number, r.machine_id, m.short_name AS machine_short_name,
        m.display_name AS machine_display_name,
        r.space_id, sp.name AS space_name, p.name AS project_name,
        r.started_at, r.finished_at, r.agent, r.job,
        r.status, r.latency_ms, r.prompt_head, r.task_key, r.failure_kind, r.vendor_tokens,
        r.model_calls, r.peak_call_tokens, r.quota_used_percent_start, r.quota_used_percent_end,
        r.quota_window_minutes, r.quota_resets_at,
        r.vendor_cost_usd, r.vendor_input_tokens, r.vendor_output_tokens,
        r.vendor_estimated_cost_usd, r.vendor_cost_source, r.label, r.lens,
        r.parent_run_id, r.turn, r.evidence_excluded,
        r.probe, s.delivery, s.quality, s.fidelity, s.scored_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN machine m ON m.id=r.machine_id
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
  // Counters count the whole window, as the local page does; filters narrow only the tables.
  const totals = {
    runs: eligible.length,
    scored: eligible.filter(
      (run) =>
        run.score !== null &&
        run.evidenceExcluded === null &&
        !NOT_EVIDENCE.includes(run.failureKind as (typeof NOT_EVIDENCE)[number]),
    ).length,
    voided: eligible.filter((run) => run.evidenceExcluded !== null).length,
    failed: eligible.filter((run) => run.status === 'failed').length,
  }
  const unscored = eligible.filter((run) => {
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
  const agentTokens = new Map<string, number | null>()
  for (const run of eligible) {
    agentRuns.set(run.agent, (agentRuns.get(run.agent) ?? 0) + 1)
    const sum = agentTokens.get(run.agent) ?? null
    agentTokens.set(run.agent, run.vendorTokens === null ? sum : (sum ?? 0) + run.vendorTokens)
  }
  const vendors = [...agentTokens].map(([agent, tokens]) => ({
    agent,
    tokens,
    runs: agentRuns.get(agent) ?? 0,
  }))
  vendors.sort(
    (left, right) =>
      (right.tokens ?? -1) - (left.tokens ?? -1) || left.agent.localeCompare(right.agent),
  )
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
      SELECT r.id, r.number, r.machine_id, m.short_name AS machine_short_name,
        m.display_name AS machine_display_name,
        r.space_id, sp.name AS space_name, p.name AS project_name,
        r.started_at, r.finished_at, r.agent, r.job, r.status, r.latency_ms,
        r.prompt_head, r.task_key, r.failure_kind, r.vendor_tokens, r.model_calls,
        r.peak_call_tokens, r.quota_used_percent_start, r.quota_used_percent_end,
        r.quota_window_minutes, r.quota_resets_at, r.vendor_cost_usd,
        r.vendor_input_tokens, r.vendor_output_tokens, r.vendor_estimated_cost_usd,
        r.vendor_cost_source,
        r.label, r.lens, r.parent_run_id, r.turn, r.evidence_excluded, r.probe,
        s.delivery, s.quality, s.fidelity, s.scored_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN machine m ON m.id=r.machine_id
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
        m.short_name AS machine_short_name, m.display_name AS machine_display_name,
        s.delivery, s.quality, s.fidelity, s.scored_at,
        s.note, s.scored_by, s.updated_at AS score_updated_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN machine m ON m.id=r.machine_id
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
        NULL::integer AS review_number, rv.tier, rv.patch_id, rv.commit_message,
        COALESCE(json_agg(f ORDER BY f.ordinal) FILTER (WHERE f.id IS NOT NULL), '[]') AS findings
      FROM review_lens l JOIN review rv ON rv.id=l.review_id LEFT JOIN review_finding f ON f.review_lens_id=l.id
      WHERE l.run_id=${input.id}::uuid GROUP BY l.id, rv.id
      ORDER BY rv.recorded_at DESC, l.created_at DESC, l.lens, l.agent
    `
    const detail = recordPresentation(row)
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
      reviews: lenses.map((lens: Record<string, unknown>) => reviewLensPresentation(lens)),
    } as RecordRunDetail
  })
}
