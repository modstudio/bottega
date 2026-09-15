// concern: run-control
/**
 * Knows run rows, chains, detached continuation, events, output, and exit
 * behaviour. Must not know transports, worktrees, routing, reviews, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CONTINUE_WORKING_FORMS } from './args.ts'
import { clock } from './clock.ts'
import { branchNote, failoverSummary, resolveFailover } from './collect.ts'
import { db, writeTransaction } from './db.ts'
import { chainTransport } from './failover.ts'
import { mcpRequestFromStored } from './mcp-preflight.ts'
import { outcomeOf } from './outcome.ts'
import { packedResumePrompt } from './run.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from './run-authority.ts'
import { detach } from './run-dispatch.ts'
import { reapStale, STALE_AFTER_MS } from './run-liveness.ts'

export type RunControlPresentation = {
  dur(ms: number | null | undefined): string
  scoreHint(id: number, jobName: string, parent: number | null): string
  argvResumeLimit(agentName: string): number | undefined
  printRunId(id: number): void
}

const FOLLOW_TIMEOUT_MS = STALE_AFTER_MS + 60_000

function runEvidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded ? '\n  not routing evidence: ' + row.evidence_excluded : ''
}

/**
 * Watch a detached run to its terminal state and report it as the caller expects.
 *
 * Shared by `do` and `retry` because they have the same exposure: whichever
 * process is holding the agent as a child is the process whose death destroys
 * the work. Neither holds it any more.
 */
export async function follow(
  id: number,
  quiet: boolean,
  exitOnFailure = true,
  presentation: RunControlPresentation,
): Promise<string> {
  const deadline = clock().now() + FOLLOW_TIMEOUT_MS
  const q = db().query(
    `SELECT id, status, agent, job, parent_run_id, latency_ms, vendor_tokens,
            output_path, error, route_reason, evidence_excluded
       FROM run WHERE id = ?`,
  )
  for (;;) {
    const chain = resolveFailover(db(), id)
    const row = q.get(chain.finalId) as {
      id: number
      status: string
      agent: string
      job: string
      parent_run_id: number | null
      latency_ms: number | null
      vendor_tokens: number | null
      output_path: string | null
      error: string | null
      route_reason: string | null
      evidence_excluded: string | null
    } | null
    const outcome = row ? outcomeOf(row) : null
    if (row && outcome?.terminal && !chain.settling) {
      const out =
        row.output_path && existsSync(row.output_path) ? readFileSync(row.output_path, 'utf8') : ''
      if (out) console.log(out)
      const failover = failoverSummary(chain.attempts)
      if (failover) console.error(`\n— ${failover}`)
      /**
       * ASKING IS NOT A FAILURE, and printing it as one undoes the rename.
       *
       * A worker that stopped to get a decision did exactly what it was told
       * to. This branch reported it as `asking: no output` and exited 1 — the
       * same shape as a crash, on the one outcome the whole escalation design
       * exists to produce. Its questions are the output; they are simply not in
       * the file this was looking at.
       */
      if (row.status === 'asking') {
        const open = db()
          .query(
            `SELECT q.question FROM question q JOIN run r ON r.id = q.run_id
            WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL
            ORDER BY q.id`,
          )
          .all(row.parent_run_id ?? chain.finalId, row.parent_run_id ?? chain.finalId) as {
          question: string
        }[]
        console.error(
          `\n— run ${row.id} · ${row.agent} · stopped to ask` +
            (row.latency_ms ? ` after ${presentation.dur(row.latency_ms)}` : '') +
            '\n' +
            open.map((q) => `  · ${q.question}`).join('\n') +
            `\n\n  ${outcome.line}` +
            `\n  orch inbox              the questions in full` +
            `\n  orch answer ${row.parent_run_id ?? chain.finalId} ...   rule, and it resumes where it stopped` +
            `\n  orch diff ${row.parent_run_id ?? chain.finalId}          what it changed before it asked`,
        )
        return row.status
      }
      if (!outcome.ok) {
        if (exitOnFailure) {
          console.error(
            `\n— run ${row.id} · ${row.agent} · ${row.status}: ${row.error ?? 'no output'}`,
          )
          process.exit(1)
        }
        return row.status
      }
      if (quiet) return row.status
      console.error(
        `\n— run ${row.id} · ${row.agent}` +
          (row.route_reason ? ` (${row.route_reason})` : '') +
          ` · ${presentation.dur(row.latency_ms ?? 0)}` +
          (row.vendor_tokens ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens` : '') +
          `\n  score it:  ${presentation.scoreHint(chain.finalId, row.job, row.parent_run_id)}` +
          branchNote(db(), row.id) +
          runEvidenceNote(row),
      )
      return row.status
    }
    if (clock().now() >= deadline) {
      // Deliberately NOT a kill. The worker is detached and may still be
      // working; saying where to look for it is more use than destroying it.
      console.error(
        `— run ${id} still going after ${Math.round(FOLLOW_TIMEOUT_MS / 60_000)}m.` +
          ` It is detached and will finish on its own:  orch run ${id}`,
      )
      process.exit(2)
    }
    const observed = reapStale()
    if (Array.isArray(observed) && observed.some((dead) => dead.id === chain.finalId)) {
      console.error(
        `run ${chain.finalId}: process gone, not terminalised (read-only linked worktree)`,
      )
      if (exitOnFailure) process.exitCode = 1
      return row?.status ?? 'running'
    }
    await new Promise<void>((resolve) => clock().setTimeout(() => resolve(), 1000))
  }
}

export function refuseEscapedChain(id: number): void {
  const root = db()
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(id) as { root_id: number } | null
  const rows = root
    ? (db()
        .query(
          `SELECT id, failure_kind, pre_confinement FROM run
      WHERE (id=? OR parent_run_id=?) AND failure_kind IN ('escaped','confinement_unverified')
      ORDER BY id DESC`,
        )
        .all(root.root_id, root.root_id) as {
        id: number
        failure_kind: string
        pre_confinement: string | null
      }[])
    : []
  if (!rows.length) return
  const kind = rows[0]!.failure_kind
  const recovery = rows.some((row) => !row.pre_confinement)
    ? 'snapshot missing in this chain: clear uses the available snapshots and moves missing outcomes forward'
    : 'snapshots available: clear restores the pre-confinement outcomes'
  throw new Error(
    `run ${id} is ${kind} (${recovery})\n` +
      'invariant: an escaped or confinement-unverified chain is not resumed until the classification is cleared\n' +
      `cleared by: orch confinement clear ${id} --writer TEXT --note TEXT`,
  )
}

/** Resume a root run through the one path shared by `continue` and writing retries. */
export async function continueRun(
  id: number,
  message: string | undefined,
  argvResumeLimit: RunControlPresentation['argvResumeLimit'],
): Promise<{ childId: number; job: string }> {
  let authority = authorizeRunMutation(id, 'continue')
  const row = db().query('SELECT id, job, parent_run_id, status FROM run WHERE id = ?').get(id) as {
    id: number
    job: string
    parent_run_id: number | null
    status: string
  } | null
  if (!row) throw new Error(`no run ${id}`)
  refuseEscapedChain(id)
  if (row.parent_run_id) {
    throw new Error(`run ${id} is a turn of run ${row.parent_run_id}; continue that one`)
  }
  if (row.status === 'stale') {
    throw new Error(`run ${id} is ${row.status} and cannot be continued`)
  }
  const recordedReview = db()
    .query('SELECT review_id FROM review_lens WHERE run_id=?')
    .get(row.id) as { review_id: number } | null
  if (recordedReview) {
    throw new Error(
      `run ${id} has a recorded review and cannot be continued\n` +
        "invariant: a recorded review is the run's product and is not re-terminalised\n" +
        'cleared by: dispatch a new review run',
    )
  }
  const running = db()
    .query(
      `SELECT id, turn FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn, id LIMIT 1`,
    )
    .get(id, id) as { id: number; turn: number } | null
  if (running) {
    throw new Error(`run ${id} already has running turn ${running.id} (turn ${running.turn})`)
  }
  const open = db()
    .query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
      WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    )
    .get(id, id) as { n: number }
  // A worker waiting on a ruling must be RULED ON, not talked past. Continuing
  // one would resume it with its question unanswered, and a worker resumed
  // with an open question guesses — the single thing this design exists to
  // prevent.
  if (open.n)
    throw new Error(`run ${id} is waiting on ${open.n} question(s): orch answer ${id} ...`)
  const latest = db()
    .query(
      `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source
       FROM run WHERE id = ? OR parent_run_id = ?
      ORDER BY turn DESC LIMIT 1`,
    )
    .get(id, id) as {
    id: number
    agent: string
    vendor_session: string | null
    turn: number
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: 'recipe' | 'git' | 'readonly_recipe' | null
  }
  const checkpointContext = (await import('./checkpoint.ts')).checkpointResumeContext(
    db(),
    id,
    latest.worktree,
  )
  const sessionFrom = checkpointContext
    ? null
    : latest.vendor_session
      ? latest
      : (db()
          .query(
            `SELECT id, agent, vendor_session, turn
           FROM run WHERE (id = ? OR parent_run_id = ?) AND vendor_session IS NOT NULL
          ORDER BY turn DESC LIMIT 1`,
          )
          .get(id, id) as {
          id: number
          agent: string
          vendor_session: string
          turn: number
        } | null)
  if (!checkpointContext && !sessionFrom?.vendor_session) {
    throw new Error(`run ${id} recorded no session id, so ${latest.agent} cannot be resumed`)
  }
  if (!checkpointContext && !latest.vendor_session) {
    console.error(
      `run ${id}: newest turn ${latest.id} recorded no session id; ` +
        `resuming ${sessionFrom!.agent} with the session from run ${sessionFrom!.id} (turn ${sessionFrom!.turn})`,
    )
  }
  let prompt: string
  if (checkpointContext) {
    const rootPrompt = db().query('SELECT prompt_path FROM run WHERE id=?').get(id) as {
      prompt_path: string | null
    }
    if (!rootPrompt.prompt_path || !existsSync(rootPrompt.prompt_path)) {
      throw new Error(
        `run ${id} checkpoint cannot continue: its original prompt file is unavailable`,
      )
    }
    prompt = [checkpointContext, readFileSync(rootPrompt.prompt_path, 'utf8'), message]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
  } else {
    prompt =
      message ??
      'Continue from where you stopped and finish the spec. If you reached a ' +
        'decision that is not yours, stop and ask as before.'
  }
  const assembledLimit = checkpointContext ? undefined : argvResumeLimit(sessionFrom!.agent)
  if (assembledLimit !== undefined) {
    const packed = packedResumePrompt(row.job, prompt, id)
    const assembled = Buffer.byteLength(packed, 'utf8')
    if (assembled > assembledLimit) {
      throw new Error(
        `assembled resume prompt is ${assembled} bytes; this agent's resume transport is bounded at ${assembledLimit} bytes\n` +
          `nothing was stored\nworking forms:\n${CONTINUE_WORKING_FORMS}`,
      )
    }
  }
  const launch = db()
    .query(
      `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover, mcp, mcp_error, lens
       FROM run WHERE id=?`,
    )
    .get(id) as {
    launch_cwd: string | null
    launch_seed: string | null
    launch_key: string | null
    launch_base: string | null
    no_failover: number
    mcp: number | null
    mcp_error: string | null
    lens: string | null
  }
  authority = writeTransaction(() => {
    const adopted = adoptRunMutation(authority, 'continue')
    // Stop preserves the artifact specifically so this transition can reopen it.
    db().query("UPDATE run SET status='failed' WHERE id=? AND status='stopped'").run(id)
    return adopted
  })
  const childId = await detach(row.job, prompt, {
    cwd: latest.cwd ?? process.cwd(),
    seed: launch.launch_seed ?? undefined,
    key: launch.launch_key ?? undefined,
    base: launch.launch_base ?? undefined,
    noFailover: !!launch.no_failover,
    mcp: mcpRequestFromStored(launch.mcp, launch.mcp_error),
    lens: launch.lens ?? undefined,
    transport: chainTransport(id) ?? undefined,
    resume: {
      parent: id,
      agent: checkpointContext ? latest.agent : sessionFrom!.agent,
      session: checkpointContext ? undefined : (sessionFrom!.vendor_session ?? undefined),
      fresh: Boolean(checkpointContext),
      turn: latest.turn + 1,
      sessionId: authority.owner,
      worktree: latest.worktree
        ? {
            path: latest.worktree,
            branch: latest.branch ?? '',
            base: latest.base_commit ?? '',
            repoRoot:
              (await import('./git-environment.ts')).repoRootOf(latest.worktree) ?? process.cwd(),
            source: latest.worktree_source ?? undefined,
          }
        : null,
    },
  })
  auditRunMutation(authority, 'continue', message ?? null)
  return { childId, job: row.job }
}

export async function reportContinuedRun(
  childId: number,
  jobName: string,
  flags: { detach: boolean; follow: boolean; quiet: boolean },
  presentation: RunControlPresentation,
): Promise<void> {
  if (flags.detach || !flags.follow) {
    presentation.printRunId(childId)
    if (!flags.quiet) {
      console.error(
        `\n— ${jobName} runs detached; a foreground one dies with its shell.` +
          `\n  orch wait ${childId}      then:  orch result ${childId}` +
          `\n  orch inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
      )
    }
    return
  }
  await follow(childId, flags.quiet, true, presentation)
}
