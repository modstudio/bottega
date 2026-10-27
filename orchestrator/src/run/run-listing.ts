// concern: run-listing
/** Knows run list and state rendering. Must not know run control, transports, routing, the CLI, or worktrees. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RunIdentity } from '../../../shared/orch-contract.ts'
import {
  type FailoverSuccessor,
  failoverSuccessors,
  mayStillFailOver,
  resolveFailover,
} from '../collect/collect.ts'
import { db } from '../database/db.ts'
import { liveOperationalStatusFromEvents, readEventLog, runEventsPath } from '../events.ts'
import { UNSCORED_WHERE } from '../evidence/evidence-query.ts'
import { failureReason, type OutcomeRow, outcomeOf } from '../outcome.ts'
import type { ProcessSample } from '../process-resource-sampler.ts'
import { currentRunMemberJoin, liveMemberStall } from './live-run-member.ts'
import { questionOpenSql } from './question-open.ts'
import type {
  AnswerChannel,
  AnswererKind,
  AskedVia,
  QuestionDeliveryMode,
  QuestionDeliveryOutcome,
} from './question-vocabulary.ts'
import { isFreshRunHostWait, RUN_HOST_WAIT_MAX_MS } from './run-host-capacity.ts'
import { classifyRunIdentifier, resolveRunIdentifierOrNull } from './run-identifier.ts'
import { type SubscriptionCostContext, withReportedCost } from './run-subscription-cost.ts'
import { subscriptionCostFacts } from './run-subscription-cost-store.ts'
import { agentWorkValue } from './synthetic-lifecycle-job.ts'

const FAILURE_KINDS_WITH_LISTED_ERROR = new Set(['contract', 'unevidenced', 'premature-final'])

const RUN_LIVE_STATUSES = ['queued', 'reserved', 'attached', 'running', 'asking'] as const

export function runIdentityMap(): RunIdentity[] {
  return db().query<RunIdentity, []>('SELECT number, record_id FROM run ORDER BY number').all()
}

function questionDeliveries(questionRecordId: string) {
  return db()
    .query(
      `SELECT delivery.id,question.number question_id,delivery.question_record_id,
              delivery_run.number AS run_number, delivery.run_record_id,
              delivery.mode, delivery.outcome, delivery.at, delivery.error
         FROM question_delivery delivery
         JOIN question ON question.record_id=delivery.question_record_id
         LEFT JOIN run delivery_run ON delivery_run.record_id=delivery.run_record_id
        WHERE delivery.question_record_id=? ORDER BY delivery.id`,
    )
    .all(questionRecordId) as {
    id: number
    question_id: number
    question_record_id: string
    run_number: number | null
    run_record_id: string | null
    mode: QuestionDeliveryMode
    outcome: QuestionDeliveryOutcome
    at: string
    error: string | null
  }[]
}

type RunListingFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}
type RunListingWarningRow = {
  job: string
  branch: string | null
  minted_branch: string | null
  status: string
  latency_ms: number | null
  probe: number
  output_path: string | null
  writesRepo: boolean
}

type RunListingPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
  chainIsStranded(rootId: string): boolean
  strandedRecovery(rootId: string): string
  thinOutputWarning(row: RunListingWarningRow): string | null
  processObservation: {
    sampleProcesses(): ProcessSample[]
    processStartTime(pid: number): string | null
  }
  clock(): number
  subscriptionCost?: SubscriptionCostContext
}

function listedRunWithCost(
  listed: Record<string, unknown>,
  turns: unknown,
  subscriptionCost: SubscriptionCostContext,
) {
  const pricedTurns = Array.isArray(turns)
    ? turns.map((turn) => withReportedCost(turn as Record<string, unknown>, subscriptionCost))
    : turns
  const row = pricedTurns ? { ...listed, turns: pricedTurns } : listed
  return withReportedCost(row, subscriptionCost)
}

function listingHumanCurrent(finalRecordId: string, json: boolean) {
  if (json) return {}
  return db()
    .query(
      `SELECT status, latency_ms, vendor_tokens, route_reason, probe, output_path, branch, minted_branch
         FROM run WHERE record_id=?`,
    )
    .get(finalRecordId) as {
    status: string
    latency_ms: number | null
    vendor_tokens: number | null
    route_reason: string | null
    probe: number
    output_path: string | null
    branch: string | null
    minted_branch: string | null
  }
}

function listingTurns(recordId: string, json: boolean) {
  if (!json) return undefined
  return db()
    .query(
      `SELECT record_id, number, started_at, agent, executor, latency_ms, vendor_tokens, model_calls, peak_call_tokens, vendor_cost_usd, vendor_estimated_cost_usd, vendor_cost_source, status, turn, input_tree, sandbox, resource_cpu_ms, resource_peak_rss_bytes, resource_samples, resource_source
         FROM run WHERE record_id = ? OR parent_run_record_id = ?
        ORDER BY turn, number`,
    )
    .all(recordId, recordId)
}

function reportRouteAndExecutor(row: Record<string, unknown>, log: (...values: unknown[]) => void) {
  if (row.route_reason) log(`      route: ${String(row.route_reason)}`)
  if (row.executor === 'harness') log('      executor: harness')
}

function listingQuestions(recordId: string, json: boolean) {
  if (!json) return undefined
  return (
    db()
      .query(
        `SELECT q.number,q.record_id,q.run_record_id,owner.number AS run_number,
                      q.asked_at, q.answered_at, q.asked_via,
                      q.answerer_kind, q.answer_channel, q.overturned_at,
                      q.closed_at, q.close_reason
         FROM question q JOIN run owner ON owner.record_id = q.run_record_id
        WHERE owner.record_id = ? OR owner.parent_run_record_id = ?
        ORDER BY q.number`,
      )
      .all(recordId, recordId) as {
      number: number
      record_id: string
      run_record_id: string
      run_number: number
      asked_at: string
      answered_at: string | null
      asked_via: AskedVia | null
      answerer_kind: AnswererKind | null
      answer_channel: AnswerChannel | null
      overturned_at: string | null
      closed_at: string | null
      close_reason: string | null
    }[]
  ).map((q) => ({
    id: q.number,
    record_id: q.record_id,
    run_record_id: q.run_record_id,
    run_number: q.run_number,
    asked_at: q.asked_at,
    answered_at: q.answered_at ?? null,
    asked_via: q.asked_via ?? null,
    answerer_kind: q.answerer_kind ?? null,
    answer_channel: q.answer_channel ?? null,
    overturned_at: q.overturned_at ?? null,
    closed_at: q.closed_at ?? null,
    close_reason: q.close_reason ?? null,
    deliveries: questionDeliveries(q.record_id),
  }))
}

function listingCostContext(
  json: boolean,
  subscriptionCost: SubscriptionCostContext | undefined,
): SubscriptionCostContext | undefined {
  if (!json) return undefined
  return subscriptionCost ?? { facts: subscriptionCostFacts(), prices: {} }
}

function listingConversation(
  r: Record<string, unknown>,
  json: boolean,
  subscriptionCost: SubscriptionCostContext | undefined,
  chainIsStranded: (id: string) => boolean,
  strandedRecovery: (id: string) => string,
): Record<string, unknown>[] {
  const chain = resolveFailover(db(), r.record_id as string)
  const final = chain.attempts.at(-1)!
  const recordId = String(r.record_id)
  const questions = listingQuestions(recordId, json)
  const listed = {
    ...r,
    ...listingHumanCurrent(final.record_id, json),
    ...(questions ? { questions } : {}),
    answer_agent: final.agent,
    failover_chain: chain.attempts.map((attempt) => attempt.agent),
    ...(chainIsStranded(recordId)
      ? {
          status: 'stranded',
          stranded: true,
          recovery_hint: strandedRecovery(recordId),
        }
      : {}),
  }
  if (!subscriptionCost) return [listed]
  return [listedRunWithCost(listed, listingTurns(recordId, json), subscriptionCost)]
}

function processSamplesForRows(
  rows: Record<string, unknown>[],
  sampleProcesses: () => ProcessSample[],
): ProcessSample[] {
  return rows.some((row) => row.status === 'running') ? sampleProcesses() : []
}

function freshListedRunHostWait(row: Record<string, unknown>, now: number): boolean {
  return isFreshRunHostWait(String(row.status), (row.host_wait_since as string | null) ?? null, now)
}

/** The member's own terminal instant, the point a successor's wait starts from. */
function terminalInstantMs(row: Record<string, unknown>): number | null {
  const startedAt = (row.current_started_at ?? row.started_at) as string | null
  const latency = (row.current_latency_ms ?? row.latency_ms) as number | null
  if (!startedAt || typeof latency !== 'number') return null
  const started = Date.parse(startedAt)
  return Number.isFinite(started) ? started + latency : null
}

/**
 * Until when this failed run's automatic failover successor is worth waiting
 * for, or null when none can still start.
 *
 * A caller that already reported the failure has no other way to learn that a
 * successor started afterwards, since the successor is a separate root that a
 * read of this one does not return. The closing run picks that successor's
 * agent, and its selection can wait for host capacity first — bounded by
 * RUN_HOST_WAIT_MAX_MS — so the wait this publishes is the run's own terminal
 * instant plus that bound. It is published whether or not it has already
 * passed: the reader holds the clock, and a cutoff is a fact about the run.
 */
function automaticFailoverWatchUntil(
  row: Record<string, unknown>,
  successor: FailoverSuccessor | null,
): string | null {
  if (successor) return null
  const failed = {
    // The member's own status, not the listing's status column: a FAILS_OVER
    // failure whose chain holds an answered ruling still pending delivery is
    // presented as `stranded`, and that label is exactly the state whose late
    // successor this window covers — the successor is what claims the delivery.
    status: String(row.live_member_status ?? row.status),
    failure_kind: (row.failure_kind as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  }
  if (!mayStillFailOver(failed)) return null
  const ended = terminalInstantMs(row)
  return ended === null ? null : new Date(ended + RUN_HOST_WAIT_MAX_MS).toISOString()
}

/**
 * Publish each listed run's automatic failover successor, and the instant its
 * wait for one ends.
 *
 * Every listed row can be a failure awaiting a successor, so one read answers
 * for all of them rather than one query per row. The member timing column the
 * wait is anchored on is internal to the listing and does not reach the row.
 */
function withFailoverWatch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const successorByRoot = failoverSuccessors(
    db(),
    rows.map((row) => String(row.record_id)),
  )
  return rows.map((row) => {
    const { current_latency_ms: _currentLatencyMs, ...published } = row
    const successor = successorByRoot.get(String(row.record_id)) ?? null
    return {
      ...published,
      automatic_failover_successor:
        successor === null ? null : { number: successor.number, agent: successor.agent },
      automatic_failover_watch_until: automaticFailoverWatchUntil(row, successor),
    }
  })
}

function withRetryRecordId(row: Record<string, unknown>): Record<string, unknown> {
  row.retry_record_id = row.retry_of_record_id ?? null
  delete row.retry_of_record_id
  return row
}

function runListingWarningRow(row: Record<string, unknown>): RunListingWarningRow {
  return {
    job: String(row.job),
    status: String(row.status),
    latency_ms: row.latency_ms as number | null,
    probe: Number(row.probe),
    output_path: row.output_path as string | null,
    writesRepo: false,
    branch: row.branch as string | null,
    minted_branch: row.minted_branch as string | null,
  }
}

function lifecyclePresentation(
  row: Record<string, unknown>,
  outcome: ReturnType<typeof outcomeOf>,
): { status: string; detail: string | null } {
  if (row.stranded === true) return { status: 'stranded', detail: String(row.recovery_hint) }
  const status = outcome.line.split(' - ', 1)[0]!
  const hostWaitSince = row.host_wait_since as string | null
  if (row.waiting_for_capacity === true)
    return { status: 'waiting', detail: row.live_status_detail as string }
  if (row.throttled) return { status: 'throttled', detail: row.live_status_detail as string }
  if (isFreshRunHostWait(String(row.status), hostWaitSince))
    return { status: 'waiting', detail: `waiting for host capacity since ${hostWaitSince}` }
  return {
    status,
    detail: row.status === 'asking' ? outcome.line.slice(status.length + 3) : null,
  }
}

function liveOperationalStatus(liveMemberId: string, live: boolean) {
  const eventLog = live ? readEventLog(runEventsPath(liveMemberId)) : []
  return liveOperationalStatusFromEvents(eventLog)
}

function addExactFilter(
  where: string[],
  args: Array<string | number>,
  clause: 'r.job = ?' | 'r.agent = ?',
  value: string | undefined,
): void {
  if (!value) return
  where.push(clause)
  args.push(value)
}

function resolveRequestedRunIds(values: string[]): { ids: string[]; unknown: string[] } {
  const ids = new Set<string>()
  const unknown: string[] = []
  for (const value of values) {
    const parsed = classifyRunIdentifier(value)
    if (!parsed) throw new Error(`invalid run id: ${value}`)
    const id = resolveRunIdentifierOrNull(db(), value)
    if (id !== null) ids.add(id)
    else unknown.push(parsed.kind === 'record-id' ? parsed.recordId : value)
  }
  return { ids: [...ids], unknown }
}

function applyRequestedRunFilter(
  requested: { ids: string[]; unknown: string[] },
  sinceFlag: string | undefined,
  where: string[],
  args: (string | number)[],
): void {
  if ((requested.ids.length || requested.unknown.length) && sinceFlag) {
    throw new Error(`${PLATFORM_SLUG} run list --id and --since cannot be combined`)
  }
  // Every requested id was unknown, so no run in the store is this listing's to
  // return: matching nothing is the honest answer, and it keeps the read from
  // becoming a scan of the whole run table.
  if (!requested.ids.length) {
    if (requested.unknown.length) where.push('0')
    return
  }
  const marks = requested.ids.map(() => '?').join(',')
  where.push(`(r.record_id IN (${marks}) OR EXISTS (
    SELECT 1 FROM run requested_turn
     WHERE requested_turn.parent_run_record_id = r.record_id
       AND requested_turn.record_id IN (${marks})
  ))`)
  args.push(...requested.ids, ...requested.ids)
}

function liveStatusSql(): string {
  return RUN_LIVE_STATUSES.map((status) => `'${status}'`).join(',')
}

function liveListingClauses(enabled: boolean): string[] {
  return enabled
    ? [
        `EXISTS (
          SELECT 1 FROM run live_member
           WHERE (live_member.record_id = r.record_id OR live_member.parent_run_record_id = r.record_id)
             AND live_member.status IN (${liveStatusSql()})
        )`,
      ]
    : []
}

function listingMemberJoin(rootAlias: string, live: boolean): string {
  if (!live) return currentRunMemberJoin(rootAlias)
  return `JOIN run current_run ON current_run.record_id = (
    SELECT member.record_id FROM run member
     WHERE member.record_id = ${rootAlias}.record_id OR member.parent_run_record_id = ${rootAlias}.record_id
     ORDER BY CASE WHEN member.status IN (${liveStatusSql()}) THEN 0 ELSE 1 END,
              member.turn DESC, member.number DESC LIMIT 1
  )`
}

function listingLimit(value: string | undefined, json: boolean, live: boolean): number | null {
  if (value === undefined && live) return null
  return Number(value ?? (json ? 100000 : 20))
}

function listingLimitSql(limit: number | null): string {
  return limit === null ? '' : ' LIMIT ?'
}

function listingLimitBindings(limit: number | null): number[] {
  return limit === null ? [] : [limit]
}

function unscoredListingClauses(enabled: boolean, where: string[]): { cte: string; join: string } {
  if (!enabled) return { cte: '', join: '' }
  const owedWhere = UNSCORED_WHERE.replaceAll('r.', 'owed.').replaceAll('s.', 'owed_score.')
  where.push(`EXISTS (
    SELECT 1 FROM run owed
    LEFT JOIN score owed_score ON owed_score.run_record_id = owed.record_id
    WHERE owed.record_id = final.root_id AND ${owedWhere}
  )`)
  return {
    cte: `WITH RECURSIVE failover_chain(origin_id, root_id) AS (
      SELECT root.record_id, root.record_id FROM run root WHERE root.parent_run_record_id IS NULL
      UNION ALL
      SELECT chain.origin_id, successor.record_id
        FROM failover_chain chain
        JOIN run successor ON successor.record_id = (
          SELECT next.record_id FROM run next
           WHERE next.automatic_failover = 1
             AND next.retry_of_record_id IN (
               SELECT member.record_id FROM run member
                WHERE member.record_id = chain.root_id OR member.parent_run_record_id = chain.root_id
             )
           ORDER BY next.number LIMIT 1
        )
    ), final_failover(origin_id, root_id) AS (
      SELECT chain.origin_id, chain.root_id
        FROM failover_chain chain
       WHERE NOT EXISTS (
         SELECT 1 FROM run next
          WHERE next.automatic_failover = 1
            AND next.retry_of_record_id IN (
              SELECT member.record_id FROM run member
               WHERE member.record_id = chain.root_id OR member.parent_run_record_id = chain.root_id
            )
       )
    )`,
    join: 'JOIN final_failover final ON final.origin_id = r.record_id',
  }
}

function publishUnknownRuns(input: {
  ids: string[]
  recordIds: string[]
  publish(data: unknown): string
  log(value: string): void
}): void {
  for (const id of input.ids)
    input.log(input.publish({ number: Number(id), status: 'unknown', unknown: true }))
  for (const value of input.recordIds) {
    const parsed = classifyRunIdentifier(value)
    input.log(
      input.publish(
        parsed?.kind === 'record-id'
          ? { record_id: value, status: 'unknown', unknown: true }
          : { number: Number(value), status: 'unknown', unknown: true },
      ),
    )
  }
}

export async function runListingCommand(
  options: { jsonV1: boolean },
  flags: RunListingFlags,
  presentation: RunListingPresentation,
): Promise<void> {
  const { has, flag, values } = flags
  const {
    log,
    dur,
    chainIsStranded,
    strandedRecovery,
    thinOutputWarning,
    processObservation,
    clock,
    subscriptionCost,
  } = presentation
  const { idleLabel, idleMsSince } = await import('../events.ts')
  const { parseIdleReclaimedMs } = await import('../idle-kill.ts')
  const json = has('json') || options.jsonV1
  const costContext = listingCostContext(json, subscriptionCost)
  const where: string[] = ['r.parent_run_record_id IS NULL']
  if (!json) where.push('r.automatic_failover = 0')
  // Typed as the bindings SQLite actually accepts: `unknown[]` does not
  // satisfy the query signature, which is why this file never typechecked.
  const args: (string | number)[] = []
  addExactFilter(where, args, 'r.job = ?', flag('job'))
  addExactFilter(where, args, 'r.agent = ?', flag('agent'))
  const onlyUnscored = has('unscored')
  const { cte: unscoredCte, join: unscoredJoin } = unscoredListingClauses(onlyUnscored, where)
  const sinceFlag = flag('since')
  const requested = resolveRequestedRunIds(values('id'))
  const { ids: requestedIds, unknown: unknownRecordIds } = requested
  // Runs normally presents one canonical row per resumed conversation. If a caller names a child
  // turn, return that conversation rather than falsely reporting an existing run id as unknown.
  applyRequestedRunFilter(requested, sinceFlag, where, args)
  if (sinceFlag) {
    // A chain belongs in the window when any turn started there, any
    // question was asked, answered, or closed there, or any question is
    // still unanswered — an open ruling is current whatever its age.
    where.push(`(
      EXISTS (
        SELECT 1 FROM run turn
         WHERE (turn.record_id = r.record_id OR turn.parent_run_record_id = r.record_id)
           AND turn.started_at >= ?
      ) OR EXISTS (
        SELECT 1 FROM question q JOIN run owner ON owner.record_id = q.run_record_id
         WHERE (owner.record_id = r.record_id OR owner.parent_run_record_id = r.record_id)
           AND (${questionOpenSql('q')} OR q.asked_at >= ? OR q.answered_at >= ? OR q.closed_at >= ?)
      )
    )`)
    args.push(sinceFlag, sinceFlag, sinceFlag, sinceFlag)
  }
  where.push(...liveListingClauses(has('live')))
  const limit = listingLimit(flag('limit'), json, has('live'))
  let rows = db()
    .query(
      `${unscoredCte}
     SELECT r.record_id, r.number, r.started_at, r.agent, r.executor, r.job, r.repo, r.latency_ms, r.vendor_tokens,
            current_run.status, current_run.failure_kind, current_run.error,
            current_run.last_event_at, current_run.started_at AS current_started_at,
            current_run.latency_ms AS current_latency_ms,
            current_run.number AS live_member_number, current_run.status AS live_member_status,
            current_run.record_id AS live_member_id, current_run.record_id AS live_member_record_id,
            current_run.agent AS current_agent,
            current_run.job AS current_job, current_run.agent_pid AS current_agent_pid,
            current_run.agent_start_time AS current_agent_start_time,
            current_run.host_wait_since,
            s.delivery, s.quality,
            COALESCE(r.label, r.prompt_head) AS prompt_head, r.route_reason, r.sandbox
            ${
              json
                ? ', r.cwd, r.session_id, r.started_by_user_id, r.model_calls, r.peak_call_tokens, r.vendor_cost_usd, r.vendor_estimated_cost_usd, r.vendor_cost_source, r.probe, r.exit_code, r.input_tree, r.head_commit, r.review_ref,' +
                  ' r.prompt_path, r.branch, r.branch_kept, r.branch_kept_tip, r.retry_of_record_id, r.launch_key, r.evidence_excluded, r.resource_cpu_ms, r.resource_peak_rss_bytes, r.resource_samples, r.resource_source'
                : ''
            }
       FROM run r
       ${unscoredJoin}
       ${listingMemberJoin('r', has('live'))}
       LEFT JOIN score s ON s.run_record_id = r.record_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.number DESC${listingLimitSql(limit)}`,
    )
    .all(...args, ...listingLimitBindings(limit)) as Record<string, unknown>[]
  rows = rows
    .map(withRetryRecordId)
    .flatMap((r) => listingConversation(r, json, costContext, chainIsStranded, strandedRecovery))
  // Unknown means absent from orch, not merely absent from this presentation
  // (for example because an id names a child turn or another filter excludes
  // it). Omission and non-existence are different facts for machine callers.
  const knownIds = requestedIds.length
    ? new Set(
        (
          db()
            .query(
              `SELECT record_id FROM run WHERE record_id IN (${requestedIds.map(() => '?').join(',')})`,
            )
            .all(...requestedIds) as { record_id: string }[]
        ).map((row) => row.record_id),
      )
    : new Set<string>()
  const unknownIds = requestedIds.filter((id) => !knownIds.has(id))
  if (requestedIds.length) {
    const rootByRequested = new Map(
      (
        db()
          .query(
            `SELECT record_id requested_id, record_id requested_record_id, number requested_number,
                    COALESCE(parent_run_record_id,record_id) root_id
         FROM run WHERE record_id IN (${requestedIds.map(() => '?').join(',')})`,
          )
          .all(...requestedIds) as {
          requested_id: string
          requested_record_id: string
          requested_number: number
          root_id: string
        }[]
      ).map((requested) => [requested.requested_id, requested]),
    )
    const requestedRoots = requestedIds.flatMap((requestedId) => {
      const requested = rootByRequested.get(requestedId)
      return requested === undefined ? [] : [requested]
    })
    rows = rows.flatMap((row) =>
      requestedRoots
        .filter((requested) => requested.root_id === String(row.record_id))
        .map((requested) => ({
          ...row,
          requested_id: requested.requested_id,
          requested_record_id: requested.requested_record_id,
          requested_number: requested.requested_number,
          resolved_from: requested.requested_id === String(row.record_id) ? 'root' : 'turn',
        })),
    )
  }
  // Every listed row can be a failure awaiting a successor, so one read over
  // all of them answers for all of them, rather than one query per row.
  rows = withFailoverWatch(rows)
  const processSamples = processSamplesForRows(rows, processObservation.sampleProcesses)
  rows = rows.map((r) => {
    const live = r.status === 'running'
    const lastEventAt = (r.last_event_at as string | null) ?? null
    const startedAt = String(r.current_started_at ?? r.started_at),
      observedAt = clock()
    const idle = live
      ? idleLabel(lastEventAt, startedAt, observedAt)
      : r.failure_kind === 'idle'
        ? 'idle-killed'
        : null
    const since = live ? idleMsSince(lastEventAt, startedAt, observedAt) : null
    const stallObservation = live
      ? liveMemberStall(
          {
            record_id: String(r.live_member_record_id),
            number: Number(r.live_member_number),
            agent: String(r.current_agent),
            job: String(r.current_job),
            started_at: startedAt,
            last_event_at: lastEventAt,
            session_id: (r.session_id as string | null) ?? null,
            agent_pid: (r.current_agent_pid as number | null) ?? null,
            agent_start_time: (r.current_agent_start_time as string | null) ?? null,
            host_wait_since: (r.host_wait_since as string | null) ?? null,
          },
          processSamples,
          observedAt,
          undefined,
          processObservation.processStartTime,
        )
      : null
    const {
      current_started_at: _currentStartedAt,
      current_agent: _currentAgent,
      current_job: _currentJob,
      current_agent_pid: _currentAgentPid,
      current_agent_start_time: _currentAgentStartTime,
      ...rest
    } = r
    const reclaimed = r.failure_kind === 'idle' ? parseIdleReclaimedMs(String(r.error ?? '')) : null
    return {
      ...rest,
      ...(has('live') ? { live_statuses: RUN_LIVE_STATUSES } : {}),
      idle,
      idle_ms: since,
      waiting_for_host_capacity: freshListedRunHostWait(r, observedAt),
      ...liveOperationalStatus(String(r.live_member_record_id), live),
      stall_state: stallObservation?.state ?? null,
      stall: stallObservation?.detail ?? null,
      reclaimed_ms: reclaimed,
    }
  })

  // JSON Lines, so a consumer can stream it and a truncated read loses only
  // the last record. This is a published interface: `hub` reads it rather
  // than opening orchestrator.db, because a database shared between two concerns is
  // how two concerns quietly become one.
  if (json) {
    const publish = (data: unknown) =>
      JSON.stringify(options.jsonV1 ? data : { schema_version: 2, kind: 'run', data })
    for (const r of rows) log(publish(r))
    publishUnknownRuns({ ids: unknownIds, recordIds: unknownRecordIds, publish, log })
    return
  }

  if (!rows.length && !unknownIds.length && !unknownRecordIds.length) {
    log('no runs')
    return
  }
  for (const r of rows) {
    const outcome = outcomeOf(r as OutcomeRow)
    const lifecycle = lifecyclePresentation(r, outcome)
    const identity =
      r.resolved_from === 'turn'
        ? `${r.number} (asked as turn ${r.requested_number})`
        : String(r.number)
    log(
      `${identity.padStart(4)}  ${String((r.failover_chain as string[]).join('→')).padEnd(6)} ${String(r.job).padEnd(14)}` +
        // 'running' is not a failure, and a null latency is not zero seconds.
        ` ${String(r.status === 'failed' ? lifecycle.status.toUpperCase() : lifecycle.status).padEnd(10)}` +
        ` ${dur(r.latency_ms as number | null).padStart(8)}  ${String(r.prompt_head).slice(0, 60)}` +
        (r.idle ? `  ${r.idle}` : ''),
    )
    if (lifecycle.detail) log(`      ${lifecycle.detail}`)
    if (FAILURE_KINDS_WITH_LISTED_ERROR.has(String(r.failure_kind))) {
      log(
        `      ${failureReason(
          r as {
            status: string
            error: string | null
            failure_kind: string | null
            exit_code: number | null
          },
        )}`,
      )
    }
    if (r.failure_kind === 'idle') {
      const reclaimed = r.reclaimed_ms as number | null
      log(`      idle-killed` + (reclaimed != null ? `; reclaimed ${dur(reclaimed)} of wall` : ''))
    }
    // Keep the reason where a fan-out says its exclusions ran out so the command stays honest.
    reportRouteAndExecutor(r, log)
    const warning = agentWorkValue(String(r.job), () => thinOutputWarning(runListingWarningRow(r)))
    if (warning) log(`      ${warning}`)
  }
  for (const id of [...unknownIds, ...unknownRecordIds])
    log(`${String(id).padStart(4)}  unknown run id`)
}
