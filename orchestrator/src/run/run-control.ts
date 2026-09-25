// concern: run-control
/**
 * Knows run rows, chains, detached continuation, events, output, and exit
 * behavior and resume-tree selection. Must not know transports, worktree mechanics,
 * routing, reviews, or the CLI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CONTINUE_WORKING_FORMS } from '../cli/args.ts'
import { branchNote, failoverSummary, resolveFailover } from '../collect/collect.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { realpathOrSpelled, withoutTrailingSeparators } from '../git/checkout-identity.ts'
import { branchOf, gitContext, worktreeListPorcelain } from '../git/git-environment.ts'
import { mcpRequestFromStored } from '../mcp/mcp-preflight.ts'
import { outcomeOf } from '../outcome.ts'
import { projectAt, resolvedWorktreeTool } from '../project/projects.ts'
import { chainTransport } from '../route/failover.ts'
import {
  continuationBranchAvailability,
  continuationBranchPlan,
  parseWorktreeList,
  type ResumeTreePlan,
  resumeTreePlan,
} from './resume-tree.ts'
import { packedResumePrompt } from './run.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from './run-authority.ts'
import { detach } from './run-dispatch.ts'
import { reapStale, STALE_AFTER_MS } from './run-liveness.ts'
import { continuationResumeKind } from './run-resume-kind.ts'

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
  const deadline = Date.now() + FOLLOW_TIMEOUT_MS
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
    if (Date.now() >= deadline) {
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
    await new Promise<void>((resolve) => globalThis.setTimeout(() => resolve(), 1000))
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

export type ChainTurn = {
  id: number
  agent: string
  vendor_session: string | null
  turn: number
  cwd: string | null
  worktree: string | null
  branch: string | null
  base_commit: string | null
  worktree_source: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
}

/**
 * The turn a continuation resumes from, and the number the new turn takes.
 * A turn whose agent is still `(pending)` never started: it names no agent,
 * session or worktree to resume, so identity comes from the newest turn that
 * did start. Numbering counts every row, so a turn number never repeats.
 */
export function continuationTurn(
  rootId: number,
  chain: readonly ChainTurn[],
): { latest: ChainTurn; nextTurn: number } {
  const started = chain.filter((turn) => turn.agent !== '(pending)')
  if (!started.length) {
    throw new Error(`run ${rootId} cannot be continued: no turn in its chain ever started`)
  }
  const byTurn = (a: ChainTurn, b: ChainTurn) => b.turn - a.turn
  return {
    latest: [...started].sort(byTurn)[0]!,
    nextTurn: Math.max(...chain.map((turn) => turn.turn)) + 1,
  }
}

type StoredResumeLaunch = {
  launch_seed: string | null
  launch_key: string | null
  launch_base: string | null
  no_failover: number
  mcp: number | null
  mcp_error: string | null
  lens: string | null
}

type ResumeLaunchOptions = {
  seed: string | undefined
  key: string | undefined
  base: string | undefined
  noFailover: boolean
  mcp: ReturnType<typeof mcpRequestFromStored>
  lens: string | undefined
}

/** Map a stored launch row to the detach options a resumed turn inherits. */
export function resumeLaunchFromStored(row: StoredResumeLaunch): ResumeLaunchOptions {
  return {
    seed: row.launch_seed ?? undefined,
    key: row.launch_key ?? undefined,
    base: row.launch_base ?? undefined,
    noFailover: !!row.no_failover,
    mcp: mcpRequestFromStored(row.mcp, row.mcp_error),
    lens: row.lens ?? undefined,
  }
}

/** Read the root's launch row and return the detach options a resumed turn inherits. */
export function resumeLaunchForRoot(rootId: number): ResumeLaunchOptions {
  const row = db()
    .query(
      `SELECT launch_seed, launch_key, launch_base, no_failover, mcp, mcp_error, lens
       FROM run WHERE id=?`,
    )
    .get(rootId) as StoredResumeLaunch | null
  if (!row) throw new Error(`no run ${rootId}`)
  return resumeLaunchFromStored(row)
}

function continuationTree(
  id: number,
  row: { branch_kept: string | null; branch_kept_tip: string | null },
  latest: ChainTurn,
  launchCwd: string | null,
) {
  const latestProject = projectAt(latest.cwd ?? launchCwd ?? '')
  const latestBranchTip =
    latest.branch && latestProject
      ? gitContext(
          latestProject.path,
          'rev-parse',
          '--verify',
          `refs/heads/${latest.branch}^{commit}`,
        )
      : null
  const branchPlan = continuationBranchPlan({
    latestBranch: latest.branch,
    latestBranchTip,
    rootBranch: row.branch_kept,
  })
  const recordedBranch = branchPlan.branch
  const project = recordedBranch ? projectAt(latest.cwd ?? launchCwd ?? '') : null
  if (recordedBranch && !project)
    throw new Error(
      `run ${id} cannot be continued: no registered project contains its recorded checkout`,
    )
  const recordedTreeMatches = Boolean(
    recordedBranch &&
      latest.worktree &&
      existsSync(latest.worktree) &&
      branchOf(latest.worktree) === recordedBranch,
  )
  const worktreeTool = resolvedWorktreeTool(project)
  const plan =
    recordedBranch && project
      ? resumeTreePlan({
          rootId: id,
          branch: recordedBranch,
          recordedTreeMatches,
          hasCreate: Boolean(
            worktreeTool?.create || worktreeTool?.recipe || worktreeTool?.recipePath,
          ),
          branchTip:
            branchPlan.tip ??
            gitContext(
              project.path,
              'rev-parse',
              '--verify',
              `refs/heads/${recordedBranch}^{commit}`,
            ),
          retainedTip: gitContext(
            project.path,
            'rev-parse',
            '--verify',
            `refs/orch/retained/${id}^{commit}`,
          ),
          recordedTip: row.branch_kept_tip,
        })
      : null
  if (plan?.action === 'refuse')
    throw new Error(
      `run ${id} cannot recreate its continuation tree for branch ${recordedBranch}: ` +
        `no retained tip exists`,
    )
  return { project, recordedTreeMatches, plan, branchSource: branchPlan.source }
}

function effectiveCheckpointContext(
  saved: string | null,
  plan: ResumeTreePlan | null,
): string | null {
  if (saved) return saved
  if (!plan || plan.action === 'attach-recorded' || plan.action === 'refuse') return null
  return `CHECKPOINT RESUME\nResume from retained work at ${plan.tip}.`
}

function continuationCwd(
  plan: ResumeTreePlan | null,
  recordedTreeMatches: boolean,
  latestCwd: string | null,
  projectPath: string | null,
): string {
  if (!plan) return latestCwd ?? process.cwd()
  if (recordedTreeMatches) return latestCwd ?? projectPath!
  return projectPath!
}

function inheritedResumeWorktree(
  plan: ResumeTreePlan | null,
  latest: ChainTurn,
  projectPath: string | null,
) {
  if (plan && plan.action !== 'attach-recorded') return null
  if (!latest.worktree) return null
  return {
    path: latest.worktree,
    branch: latest.branch ?? '',
    base: latest.base_commit ?? '',
    repoRoot: projectPath ?? process.cwd(),
    source: latest.worktree_source ?? undefined,
  }
}

export function refuseHeldContinuationBranch(
  id: number,
  projectPath: string | null,
  recordedTreePath: string | null,
  plan: ResumeTreePlan | null,
): void {
  if (!plan || !projectPath) return
  const worktrees = parseWorktreeList(worktreeListPorcelain(projectPath))
  const canonicalPath = (path: string): string => withoutTrailingSeparators(realpathOrSpelled(path))
  const canonicalWorktrees = worktrees.map((worktree) => ({
    ...worktree,
    path: canonicalPath(worktree.path),
  }))
  const availability = continuationBranchAvailability(
    plan.branch,
    recordedTreePath ? canonicalPath(recordedTreePath) : null,
    canonicalWorktrees,
  )
  if (availability.action === 'continue') return
  const holdingPath =
    worktrees.find(
      (worktree, index) =>
        worktree.branch === plan.branch &&
        canonicalWorktrees[index]?.path === availability.holdingPath,
    )?.path ?? availability.holdingPath
  throw new Error(
    `run ${id} cannot continue: branch ${plan.branch} is checked out at ${holdingPath}\n` +
      `release it with git worktree remove ${holdingPath}, ` +
      `or orch tree remove ${holdingPath} if it is an orch-opened tree`,
  )
}

function recreatedTreePlan(
  plan: ResumeTreePlan | null,
): Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }> | undefined {
  return plan?.action === 'recreate-on-branch' || plan?.action === 'recreate-then-restore'
    ? plan
    : undefined
}

function recordContinuationTreeSource(
  childId: number,
  branchSource: ReturnType<typeof continuationBranchPlan>['source'],
  treePlan: ResumeTreePlan | null,
): void {
  let text = `continuation tree source: ${branchSource}; no repository branch`
  if (treePlan) {
    const ref = treePlan.tipSource ?? 'no ref'
    const tip = treePlan.tip ? ` ${treePlan.tip}` : ''
    text = `continuation tree source: ${branchSource}; ${ref}${tip}; branch ${treePlan.branch}`
  }
  appendRunEvent(childId, { ts: nowIso(), type: 'text', text })
}

/** Resume a root run through the one path shared by `continue` and writing retries. */
export async function continueRun(
  id: number,
  message: string | undefined,
  argvResumeLimit: RunControlPresentation['argvResumeLimit'],
): Promise<{ childId: number; job: string }> {
  let authority = authorizeRunMutation(id, 'continue')
  const row = db()
    .query(
      'SELECT id, job, parent_run_id, status, branch_kept, branch_kept_tip FROM run WHERE id = ?',
    )
    .get(id) as {
    id: number
    job: string
    parent_run_id: number | null
    status: string
    branch_kept: string | null
    branch_kept_tip: string | null
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
  const { latest, nextTurn } = continuationTurn(
    id,
    db()
      .query(
        `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source
         FROM run WHERE id = ? OR parent_run_id = ?`,
      )
      .all(id, id) as ChainTurn[],
  )
  const launch = db().query('SELECT launch_cwd FROM run WHERE id=?').get(id) as {
    launch_cwd: string | null
  }
  const inheritedLaunch = resumeLaunchForRoot(id)
  const {
    project,
    recordedTreeMatches,
    plan: treePlan,
    branchSource,
  } = continuationTree(id, row, latest, launch.launch_cwd)
  refuseHeldContinuationBranch(id, project?.path ?? null, latest.worktree, treePlan)
  const savedCheckpointContext = (await import('./checkpoint.ts')).checkpointResumeContext(
    db(),
    id,
    latest.worktree,
  )
  const checkpointContext = effectiveCheckpointContext(savedCheckpointContext, treePlan)
  const sessionFrom = checkpointContext
    ? null
    : latest.vendor_session
      ? latest
      : (db()
          .query(
            `SELECT id, agent, vendor_session, turn
           FROM run WHERE (id = ? OR parent_run_id = ?)
             AND agent <> '(pending)' AND vendor_session IS NOT NULL
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
  authority = writeTransaction(() => {
    const adopted = adoptRunMutation(authority, 'continue')
    // Stop preserves the artifact specifically so this transition can reopen it.
    db().query("UPDATE run SET status='failed' WHERE id=? AND status='stopped'").run(id)
    return adopted
  })
  const childId = await detach(row.job, prompt, {
    cwd: continuationCwd(treePlan, recordedTreeMatches, latest.cwd, project?.path ?? null),
    ...inheritedLaunch,
    transport: chainTransport(id) ?? undefined,
    resume: {
      kind: continuationResumeKind(Boolean(checkpointContext)),
      parent: id,
      agent: checkpointContext ? latest.agent : sessionFrom!.agent,
      session: checkpointContext ? undefined : (sessionFrom!.vendor_session ?? undefined),
      turn: nextTurn,
      sessionId: authority.owner,
      worktree: inheritedResumeWorktree(treePlan, latest, project?.path ?? null),
      treePlan: recreatedTreePlan(treePlan),
    },
  })
  recordContinuationTreeSource(childId, branchSource, treePlan)
  auditRunMutation(authority, 'continue', message ?? null, db(), childId)
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
