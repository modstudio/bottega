import type { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { inspectCheckout, type SequenceKind } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { appendRunEvent, recordRunWarning } from '../events.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { renderCheckpointResumeContext } from './checkpoint-resume-context.ts'
import { decideCheckpointCommit } from './checkpoint-sequencer.ts'

export type CheckpointContainment = {
  gitDir: string | null
  hooksDir: string | null
  disableHooks: boolean
}

/**
 * A checkpoint is a delta folded into the next authored commit at landing.
 * Bytes captured while the worker is mid-write are corrected by the next
 * checkpoint or by the worker's own commit; checkpointing never locks the worker.
 */

/** Reading state or history never needs the containment a commit needs. */
const READ_ONLY_CONTAINMENT: CheckpointContainment = {
  gitDir: null,
  hooksDir: null,
  disableHooks: false,
}

const PROGRESS_FILE_NAME = 'progress.json'
const PRESERVATION_FAILED_FILE = 'preservation-failed.json'
export const DEFAULT_CHECKPOINT_MINUTES = 10

export function progressFileInstruction(scratchDir: string): string {
  return (
    `CHECKPOINT PROGRESS\n\nThe harness checkpoints tracked changes for you. ` +
    `After completing an item, write {"task_pointer":"<last completed item>"} as valid JSON to ` +
    `${join(scratchDir, PROGRESS_FILE_NAME)}; the latest value is injected when a preserved run continues. ` +
    `You may rely on the harness to preserve staged and modified tracked work at limits and on stop.` +
    ` A harness checkpoint may already have committed your work, so a clean tree after you finish an item is expected. ` +
    `Never create an empty commit to carry a subject, because the architect titles the landed change. ` +
    `When you do commit your own work, start the subject with the task key.`
  )
}

export function readTaskPointer(scratchDir: string): string | null {
  const path = join(scratchDir, PROGRESS_FILE_NAME)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { task_pointer?: unknown }
    return typeof value.task_pointer === 'string' && value.task_pointer.trim()
      ? value.task_pointer.trim().slice(0, 1000)
      : null
  } catch {
    return null
  }
}

function git(
  cwd: string,
  args: string[],
  guardEnvironment: NodeJS.ProcessEnv,
  containment: CheckpointContainment,
): { ok: boolean; out: string; error: string } {
  const repository = containment.disableHooks
    ? [
        `--git-dir=${containment.gitDir!}`,
        `--work-tree=${cwd}`,
        '-c',
        `core.hooksPath=${containment.hooksDir!}`,
      ]
    : ['-C', cwd]
  const p = Bun.spawnSync(['git', ...repository, ...args], {
    env: { ...targetGitEnvironment(cwd), ...guardEnvironment },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    error: p.stderr.toString().trim() || `git ${args[0]} exited ${p.exitCode}`,
  }
}

export type CheckpointResult = {
  created: boolean
  commit: string | null
  checkpointNo: number
  taskPointer: string | null
  /** The unfinished git operation that stopped this checkpoint from committing. */
  skipped: SequenceKind | null
  error: string | null
}

/**
 * The operator line for a checkpoint that declined to commit, rendered here
 * because the wall, the signal handler and the terminal path all report the
 * same fact. Final names the checkpoint taken on limit or stop.
 */
export function checkpointSkippedLine(
  result: Pick<CheckpointResult, 'skipped'>,
  input: { runId: string; final: boolean },
): string | null {
  if (!result.skipped) return null
  const scope = input.final ? 'final checkpoint' : 'checkpoint'
  return `orch: run ${input.runId} ${scope} skipped: a ${result.skipped} is in progress`
}

/** The one shape a checkpoint that committed nothing hands back. */
function noCommitCheckpoint(
  facts: CheckpointFacts,
  skipped: SequenceKind | null,
  error: string | null,
): CheckpointResult {
  return { created: false, commit: null, ...facts, skipped, error }
}

type CheckpointFacts = { checkpointNo: number; taskPointer: string | null }

type CheckpointRunInput = {
  database: Database
  runId: string
  worktree: string
  branch: string
  taskKey: string | null
  scratchDir: string
  guardEnvironment: NodeJS.ProcessEnv
  containment: CheckpointContainment
  final?: boolean
}

/** A checkpoint that committed nothing reports through the run's event log. */
function failedCheckpoint(runId: string, error: string, facts: CheckpointFacts): CheckpointResult {
  appendRunEvent(runId, { ts: nowIso(), type: 'text', text: `checkpoint failed: ${error}` })
  return noCommitCheckpoint(facts, null, error)
}

/** Stage the tree, commit it on the run branch, and record the checkpoint row. */
function commitCheckpoint(input: CheckpointRunInput, facts: CheckpointFacts): CheckpointResult {
  const staged = git(input.worktree, ['add', '-A'], input.guardEnvironment, input.containment)
  if (!staged.ok) return failedCheckpoint(input.runId, staged.error, facts)
  // Adjacent to commit so the checked branch is the ref the commit will move.
  const currentBranch = git(
    input.worktree,
    ['symbolic-ref', '--short', 'HEAD'],
    input.guardEnvironment,
    input.containment,
  )
  if (!currentBranch.ok || currentBranch.out !== input.branch) {
    return failedCheckpoint(
      input.runId,
      `checkpoint refused: expected branch ${input.branch}, found ${currentBranch.out || currentBranch.error}`,
      facts,
    )
  }
  const subject = input.taskKey
    ? `${input.taskKey} checkpoint run ${input.runId} #${facts.checkpointNo}`
    : `checkpoint run ${input.runId} #${facts.checkpointNo}`
  const committed = git(
    input.worktree,
    ['commit', ...(input.containment.disableHooks ? ['--no-verify'] : []), '-m', subject],
    input.guardEnvironment,
    input.containment,
  )
  if (!committed.ok) return failedCheckpoint(input.runId, committed.error, facts)
  const commit = git(
    input.worktree,
    ['rev-parse', 'HEAD'],
    input.guardEnvironment,
    input.containment,
  )
  if (!commit.ok) return failedCheckpoint(input.runId, commit.error, facts)
  input.database
    .query(
      `INSERT INTO run_checkpoint (record_id,run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      input.runId,
      facts.checkpointNo,
      commit.out,
      facts.taskPointer,
      input.final ? 1 : 0,
      nowIso(),
    )
  return {
    created: true,
    commit: commit.out,
    checkpointNo: facts.checkpointNo,
    taskPointer: facts.taskPointer,
    skipped: null,
    error: null,
  }
}

/** Commit staged, tracked, and untracked files to the run branch; gitignored files stay out. */
export function checkpointRun(input: CheckpointRunInput): CheckpointResult {
  const previous = input.database
    .query('SELECT COALESCE(MAX(checkpoint_no),0) n FROM run_checkpoint WHERE run_record_id=?')
    .get(input.runId) as { n: number }
  const facts: CheckpointFacts = {
    checkpointNo: previous.n + 1,
    taskPointer: readTaskPointer(input.scratchDir),
  }
  if (
    input.containment.disableHooks &&
    (!input.containment.gitDir || !input.containment.hooksDir)
  ) {
    return failedCheckpoint(
      input.runId,
      'checkpoint refused: writing ACP run has incomplete checkpoint containment',
      facts,
    )
  }
  const dirty = git(
    input.worktree,
    ['status', '--porcelain'],
    input.guardEnvironment,
    input.containment,
  )
  if (!dirty.ok) return failedCheckpoint(input.runId, dirty.error, facts)
  if (!dirty.out) return noCommitCheckpoint(facts, null, null)
  // Before staging anything: a half-applied rebase leaves unmerged entries and
  // conflict markers, and `git add -A` would resolve the conflicts it finds.
  // The answer is inspectCheckout's, the same one the project register and the
  // tree refresh read, so `git am` and bisect are skipped and named too.
  const decision = decideCheckpointCommit(inspectCheckout(input.worktree).sequence)
  if (decision.action === 'refuse') {
    return failedCheckpoint(
      input.runId,
      "checkpoint refused: could not read git's sequencer state from the worktree",
      facts,
    )
  }
  if (decision.action === 'skip') {
    recordRunWarning(
      input.runId,
      `checkpoint skipped: a ${decision.operation} is in progress in the worktree; ` +
        'nothing committed, so the operation stays in the tree for the worker to finish',
    )
    return noCommitCheckpoint(facts, decision.operation, null)
  }
  return commitCheckpoint(input, facts)
}

/**
 * A failed idle-kill checkpoint must still capture what it can before
 * standing down. The wall path is not the first place anyone should learn
 * that preservation failed.
 */
export function recordFailedIdlePreservation(input: {
  runId: string
  scratchDir: string
  worktree: string | null
  error: string
}): { notePath: string; snapshotDir: string } {
  const at = nowIso()
  appendRunEvent(input.runId, {
    ts: at,
    type: 'text',
    text: `idle kill aborted: preservation failed: ${input.error}; no prior checkpoint, leaving the worker for the wall`,
  })
  mkdirSync(input.scratchDir, { recursive: true })
  let files: string[] | null = null
  if (input.worktree && existsSync(input.worktree)) {
    try {
      files = readdirSync(input.worktree)
    } catch {
      files = null
    }
  }
  const notePath = join(input.scratchDir, PRESERVATION_FAILED_FILE)
  writeFileSync(
    notePath,
    `${JSON.stringify({
      preservation_failed: true,
      error: input.error,
      at,
      files,
    })}\n`,
  )
  const snapshotDir = join(dirname(input.scratchDir), 'preservation')
  try {
    if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true })
    cpSync(input.scratchDir, snapshotDir, { recursive: true })
  } catch {
    /* the event log and the note are the minimum */
  }
  return { notePath, snapshotDir }
}

export function latestCheckpoint(
  database: Database,
  rootId: string,
): {
  commit_sha: string
  checkpoint_no: number
  task_pointer: string | null
} | null {
  return database
    .query(
      `SELECT c.commit_sha,c.checkpoint_no,c.task_pointer
       FROM run_checkpoint c JOIN run r ON r.record_id=c.run_record_id
      WHERE r.record_id=? OR r.parent_run_record_id=? ORDER BY c.id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as {
    commit_sha: string
    checkpoint_no: number
    task_pointer: string | null
  } | null
}

/**
 * Reads the worktree's own state rather than the run's event history, because a
 * skipped checkpoint is not the only way a tree is left partway through an
 * operation. This only shapes a resume prompt, so a state git cannot report
 * counts as no operation instead of failing the continuation.
 */
function worktreeSequencerOperation(worktree: string | null): SequenceKind | null {
  if (!worktree) return null
  const decision = decideCheckpointCommit(inspectCheckout(worktree).sequence)
  return decision.action === 'skip' ? decision.operation : null
}

export function checkpointResumeContext(
  database: Database,
  rootId: string,
  worktree: string | null,
  startCommit: string | null,
  branch: string | null,
): { context: string | null; hasCheckpointRow: boolean } {
  const checkpoint = latestCheckpoint(database, rootId)
  const operation = worktreeSequencerOperation(worktree)
  if (checkpoint && (!startCommit || !branch)) {
    const launch = database
      .query('SELECT job,launch_key FROM run WHERE record_id=?')
      .get(rootId) as {
      job: string
      launch_key: string | null
    } | null
    throw new Error(
      `run ${rootId} has a checkpoint but no branch or retained ref resolves for its latest started turn; ` +
        `invariant: a resume prompt names only the commit the resumed tree exposes; ` +
        `remedy: start a fresh keyed run from a known base with ${PLATFORM_SLUG} run start ${launch?.job ?? '<job>'} ` +
        `--key ${launch?.launch_key ?? '<task key>'} --base <ref>`,
    )
  }
  const recentLog = worktree
    ? git(
        worktree,
        ['log', '--oneline', '--decorate=no', '--max-count=8'],
        {},
        READ_ONLY_CONTAINMENT,
      ).out
    : ''
  return {
    context: renderCheckpointResumeContext({
      startCommit,
      branch,
      checkpoint,
      recentLog,
      operation,
    }),
    hasCheckpointRow: Boolean(checkpoint),
  }
}
