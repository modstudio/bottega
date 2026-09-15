// concern: run-listing
/** Knows run list and state rendering. Must not know run control, transports, routing, the CLI, or worktrees. */
import { db } from './db.ts'
import { resolveFailover } from './collect.ts'
import { UNSCORED_WHERE } from './evidence-query.ts'
import { failureReason, outcomeOf, type OutcomeRow } from './outcome.ts'

type RunListingFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}
type RunListingPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
  chainIsStranded(rootId: number): boolean
  strandedRecovery(rootId: number): string
  thinOutputWarning(row: {
    job: string
    status: string
    latency_ms: number | null
    probe: number
    output_path: string | null
    writesRepo: boolean
  }): string | null
}

export async function runListingCommand(
  options: { jsonV1: boolean },
  flags: RunListingFlags,
  presentation: RunListingPresentation,
): Promise<void> {
  const { has, flag, values } = flags
  const { log, dur, chainIsStranded, strandedRecovery, thinOutputWarning } = presentation
  const { idleLabel, idleMsSince } = await import('./events.ts')
  const { parseIdleReclaimedMs } = await import('./idle-kill.ts')
  const jsonV1 = options.jsonV1
  const json = has('json') || jsonV1
  const where: string[] = ['r.parent_run_id IS NULL']
  if (!json) where.push('r.automatic_failover = 0')
  // Typed as the bindings SQLite actually accepts: `unknown[]` does not
  // satisfy the query signature, which is why this file never typechecked.
  const args: (string | number)[] = []
  const jobFlag = flag('job')
  if (jobFlag) {
    where.push('r.job = ?')
    args.push(jobFlag)
  }
  const agentFlag = flag('agent')
  if (agentFlag) {
    where.push('r.agent = ?')
    args.push(agentFlag)
  }
  const onlyUnscored = has('unscored')
  const unscoredCte = onlyUnscored
    ? `WITH RECURSIVE failover_chain(origin_id, root_id) AS (
    SELECT root.id, root.id FROM run root WHERE root.parent_run_id IS NULL
    UNION ALL
    SELECT chain.origin_id, successor.id
      FROM failover_chain chain
      JOIN run successor ON successor.id = (
        SELECT next.id FROM run next
         WHERE next.automatic_failover = 1
           AND next.retry_of IN (
             SELECT member.id FROM run member
              WHERE member.id = chain.root_id OR member.parent_run_id = chain.root_id
           )
         ORDER BY next.id LIMIT 1
      )
  ), final_failover(origin_id, root_id) AS (
    SELECT chain.origin_id, chain.root_id
      FROM failover_chain chain
     WHERE NOT EXISTS (
       SELECT 1 FROM run next
        WHERE next.automatic_failover = 1
          AND next.retry_of IN (
            SELECT member.id FROM run member
             WHERE member.id = chain.root_id OR member.parent_run_id = chain.root_id
          )
     )
  )`
    : ''
  const unscoredJoin = onlyUnscored ? 'JOIN final_failover final ON final.origin_id = r.id' : ''
  if (onlyUnscored) {
    const owedWhere = UNSCORED_WHERE.replaceAll('r.', 'owed.').replaceAll('s.', 'owed_score.')
    where.push(`EXISTS (
      SELECT 1 FROM run owed
      LEFT JOIN score owed_score ON owed_score.run_id = owed.id
      WHERE owed.id = final.root_id AND ${owedWhere}
    )`)
  }
  const sinceFlag = flag('since')
  const requestedIds = [
    ...new Set(
      values('id').map((value) => {
        const id = Number(value)
        if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid run id: ${value}`)
        return id
      }),
    ),
  ]
  if (requestedIds.length && sinceFlag) {
    throw new Error('orch runs --id and --since cannot be combined')
  }
  if (requestedIds.length) {
    const marks = requestedIds.map(() => '?').join(',')
    // Runs normally presents one canonical row per resumed conversation. If
    // a caller names a child turn, return that conversation rather than
    // falsely reporting an existing run id as unknown.
    where.push(`(r.id IN (${marks}) OR EXISTS (
      SELECT 1 FROM run requested_turn
       WHERE requested_turn.parent_run_id = r.id
         AND requested_turn.id IN (${marks})
    ))`)
    args.push(...requestedIds, ...requestedIds)
  }
  if (sinceFlag) {
    // A chain belongs in the window when any turn started there, any
    // question was asked or answered there, or any question is still
    // unanswered — an open ruling is current whatever its age.
    where.push(`(
      EXISTS (
        SELECT 1 FROM run turn
         WHERE (turn.id = r.id OR turn.parent_run_id = r.id)
           AND turn.started_at >= ?
      ) OR EXISTS (
        SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
         WHERE (owner.id = r.id OR owner.parent_run_id = r.id)
           AND (q.answered_at IS NULL OR q.asked_at >= ? OR q.answered_at >= ?)
      )
    )`)
    args.push(sinceFlag, sinceFlag, sinceFlag)
  }
  const limit = Number(flag('limit') ?? (json ? 100000 : 20))
  let rows = db()
    .query(
      `${unscoredCte}
     SELECT r.id, r.started_at, r.agent, r.job, r.repo, r.latency_ms, r.vendor_tokens,
            current_run.status, current_run.failure_kind, current_run.error,
            current_run.last_event_at, current_run.started_at AS current_started_at,
            s.delivery, s.quality,
            COALESCE(r.label, r.prompt_head) AS prompt_head, r.route_reason, r.sandbox
            ${
              json
                ? ', r.cwd, r.session_id, r.vendor_cost_usd, r.probe, r.exit_code, r.input_tree, r.head_commit, r.review_ref,' +
                  ' r.prompt_path, r.branch, r.branch_kept, r.branch_kept_tip, r.retry_of, r.launch_key, r.evidence_excluded'
                : ''
            }
       FROM run r
       ${unscoredJoin}
       JOIN run current_run ON current_run.id = (
         SELECT member.id FROM run member
          WHERE member.id = r.id OR member.parent_run_id = r.id
          ORDER BY member.turn DESC, member.id DESC LIMIT 1
       )
       LEFT JOIN score s ON s.run_id = r.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...args, limit) as Record<string, unknown>[]

  rows = rows.flatMap((r) => {
    const chain = resolveFailover(db(), Number(r.id))
    const final = chain.attempts.at(-1)!
    const current = json
      ? {}
      : (db()
          .query(
            `SELECT status, latency_ms, vendor_tokens, route_reason, probe, output_path
         FROM run WHERE id=?`,
          )
          .get(final.id) as {
          status: string
          latency_ms: number | null
          vendor_tokens: number | null
          route_reason: string | null
          probe: number
          output_path: string | null
        })
    const turns = json
      ? db()
          .query(
            `SELECT id, started_at, latency_ms, vendor_tokens, vendor_cost_usd, status, turn, input_tree, sandbox
         FROM run WHERE id = ? OR parent_run_id = ?
        ORDER BY turn, id`,
          )
          .all(Number(r.id), Number(r.id))
      : undefined
    const questions = json
      ? (
          db()
            .query(
              `SELECT q.id, q.run_id, q.asked_at, q.answered_at
         FROM question q JOIN run owner ON owner.id = q.run_id
        WHERE owner.id = ? OR owner.parent_run_id = ?
        ORDER BY q.id`,
            )
            .all(Number(r.id), Number(r.id)) as {
            id: number
            run_id: number
            asked_at: string
            answered_at: string | null
          }[]
        ).map((q) => ({
          id: q.id,
          run_id: q.run_id,
          asked_at: q.asked_at,
          answered_at: q.answered_at ?? null,
        }))
      : undefined
    return [
      {
        ...r,
        ...current,
        ...(turns ? { turns } : {}),
        ...(questions ? { questions } : {}),
        answer_agent: final.agent,
        failover_chain: chain.attempts.map((attempt) => attempt.agent),
        ...(chainIsStranded(Number(r.id))
          ? {
              status: 'stranded',
              stranded: true,
              recovery_hint: strandedRecovery(Number(r.id)),
            }
          : {}),
      },
    ]
  })

  // Unknown means absent from orch, not merely absent from this presentation
  // (for example because an id names a child turn or another filter excludes
  // it). Omission and non-existence are different facts for machine callers.
  const knownIds = requestedIds.length
    ? new Set(
        (
          db()
            .query(`SELECT id FROM run WHERE id IN (${requestedIds.map(() => '?').join(',')})`)
            .all(...requestedIds) as { id: number }[]
        ).map((row) => row.id),
      )
    : new Set<number>()
  const unknownIds = requestedIds.filter((id) => !knownIds.has(id))

  if (requestedIds.length) {
    const rootByRequested = new Map(
      (
        db()
          .query(
            `SELECT id requested_id, COALESCE(parent_run_id, id) root_id
         FROM run WHERE id IN (${requestedIds.map(() => '?').join(',')})`,
          )
          .all(...requestedIds) as { requested_id: number; root_id: number }[]
      ).map((requested) => [requested.requested_id, requested.root_id]),
    )
    const requestedRoots = requestedIds.flatMap((requested_id) => {
      const root_id = rootByRequested.get(requested_id)
      return root_id === undefined ? [] : [{ requested_id, root_id }]
    })
    rows = rows.flatMap((row) =>
      requestedRoots
        .filter((requested) => requested.root_id === Number(row.id))
        .map((requested) => ({
          ...row,
          requested_id: requested.requested_id,
          resolved_from: requested.requested_id === Number(row.id) ? 'root' : 'turn',
        })),
    )
  }

  rows = rows.map((r) => {
    const live = r.status === 'running'
    const lastEventAt = (r.last_event_at as string | null) ?? null
    const startedAt = String(r.current_started_at ?? r.started_at)
    const idle = live
      ? idleLabel(lastEventAt, startedAt)
      : r.failure_kind === 'idle'
        ? 'idle-killed'
        : null
    const since = live ? idleMsSince(lastEventAt, startedAt) : null
    const { current_started_at: _currentStartedAt, ...rest } = r
    const reclaimed = r.failure_kind === 'idle' ? parseIdleReclaimedMs(String(r.error ?? '')) : null
    return {
      ...rest,
      idle,
      idle_ms: since,
      reclaimed_ms: reclaimed,
    }
  })

  // JSON Lines, so a consumer can stream it and a truncated read loses only
  // the last record. This is a published interface: `hub` reads it rather
  // than opening orch.db, because a database shared between two concerns is
  // how two concerns quietly become one.
  if (json) {
    const publish = (data: unknown) =>
      JSON.stringify(jsonV1 ? data : { schema_version: 2, kind: 'run', data })
    for (const r of rows) log(publish(r))
    for (const id of unknownIds) {
      log(publish({ id, status: 'unknown', unknown: true }))
    }
    return
  }

  if (!rows.length && !unknownIds.length) {
    log('no runs')
    return
  }
  for (const r of rows) {
    const outcome = outcomeOf(r as OutcomeRow)
    const stranded = r.stranded === true
    const status = stranded ? 'stranded' : outcome.line.split(' - ', 1)[0]!
    const identity =
      r.resolved_from === 'turn' ? `${r.id} (asked as turn ${r.requested_id})` : String(r.id)
    log(
      `${identity.padStart(4)}  ${String((r.failover_chain as string[]).join('→')).padEnd(6)} ${String(r.job).padEnd(14)}` +
        // 'running' is not a failure, and a null latency is not zero seconds.
        ` ${String(r.status === 'failed' ? status.toUpperCase() : status).padEnd(10)}` +
        ` ${dur(r.latency_ms as number | null).padStart(8)}  ${String(r.prompt_head).slice(0, 60)}` +
        (r.idle ? `  ${r.idle}` : ''),
    )
    if (stranded) log(`      ${r.recovery_hint}`)
    else if (r.status === 'asking') log(`      ${outcome.line.slice(status.length + 3)}`)
    if (r.failure_kind === 'contract' || r.failure_kind === 'unevidenced') {
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
    // The reason is where a fan-out says its exclusions ran out. Hiding it
    // here would leave the database honest and the human-facing command not.
    if (r.route_reason) log(`      route: ${String(r.route_reason)}`)
    const warning = thinOutputWarning({
      job: String(r.job),
      status: String(r.status),
      latency_ms: r.latency_ms as number | null,
      probe: Number(r.probe),
      output_path: r.output_path as string | null,
      writesRepo: false,
    })
    if (warning) log(`      ${warning}`)
  }
  for (const id of unknownIds) log(`${String(id).padStart(4)}  unknown run id`)
  return
}
