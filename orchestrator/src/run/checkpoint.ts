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
import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { renderCheckpointResumeContext } from './checkpoint-resume-context.ts'

/**
 * A checkpoint is a delta folded into the next authored commit at landing.
 * Bytes captured while the worker is mid-write are corrected by the next
 * checkpoint or by the worker's own commit; checkpointing never locks the worker.
 */

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
): { ok: boolean; out: string; error: string } {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
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
  error: string | null
}

/** Commit staged, tracked, and untracked files to the run branch; gitignored files stay out. */
export function checkpointRun(input: {
  database: Database
  runId: number
  worktree: string
  branch: string
  taskKey: string
  scratchDir: string
  guardEnvironment: NodeJS.ProcessEnv
  final?: boolean
}): CheckpointResult {
  const previous = input.database
    .query('SELECT COALESCE(MAX(checkpoint_no),0) n FROM run_checkpoint WHERE run_id=?')
    .get(input.runId) as { n: number }
  const checkpointNo = previous.n + 1
  const taskPointer = readTaskPointer(input.scratchDir)
  const refusal = (error: string): CheckpointResult => {
    appendRunEvent(input.runId, { ts: nowIso(), type: 'text', text: `checkpoint failed: ${error}` })
    return { created: false, commit: null, checkpointNo, taskPointer, error }
  }
  const dirty = git(input.worktree, ['status', '--porcelain'], input.guardEnvironment)
  if (!dirty.ok) return refusal(dirty.error)
  if (!dirty.out) return { created: false, commit: null, checkpointNo, taskPointer, error: null }
  const staged = git(input.worktree, ['add', '-A'], input.guardEnvironment)
  if (!staged.ok) return refusal(staged.error)
  // Adjacent to commit so the checked branch is the ref the commit will move.
  const currentBranch = git(
    input.worktree,
    ['symbolic-ref', '--short', 'HEAD'],
    input.guardEnvironment,
  )
  if (!currentBranch.ok || currentBranch.out !== input.branch) {
    return refusal(
      `checkpoint refused: expected branch ${input.branch}, found ${currentBranch.out || currentBranch.error}`,
    )
  }
  const subject = `${input.taskKey} checkpoint run ${input.runId} #${checkpointNo}`
  const committed = git(input.worktree, ['commit', '-m', subject], input.guardEnvironment)
  if (!committed.ok) return refusal(committed.error)
  const commit = git(input.worktree, ['rev-parse', 'HEAD'], input.guardEnvironment)
  if (!commit.ok) return refusal(commit.error)
  input.database
    .query(
      `INSERT INTO run_checkpoint (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
     VALUES (?,?,?,?,?,?)`,
    )
    .run(input.runId, checkpointNo, commit.out, taskPointer, input.final ? 1 : 0, nowIso())
  return { created: true, commit: commit.out, checkpointNo, taskPointer, error: null }
}

/**
 * A failed idle-kill checkpoint must still capture what it can before
 * standing down. The wall path is not the first place anyone should learn
 * that preservation failed.
 */
export function recordFailedIdlePreservation(input: {
  runId: number
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
  rootId: number,
): {
  commit_sha: string
  checkpoint_no: number
  task_pointer: string | null
} | null {
  return database
    .query(
      `SELECT c.commit_sha,c.checkpoint_no,c.task_pointer
       FROM run_checkpoint c JOIN run r ON r.id=c.run_id
      WHERE r.id=? OR r.parent_run_id=? ORDER BY c.id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as {
    commit_sha: string
    checkpoint_no: number
    task_pointer: string | null
  } | null
}

export function checkpointResumeContext(
  database: Database,
  rootId: number,
  worktree: string | null,
  startCommit: string | null,
  branch: string | null,
): string | null {
  const checkpoint = latestCheckpoint(database, rootId)
  if (!checkpoint) return null
  if (!startCommit || !branch) {
    const launch = database.query('SELECT job,launch_key FROM run WHERE id=?').get(rootId) as {
      job: string
      launch_key: string | null
    } | null
    throw new Error(
      `run ${rootId} has a checkpoint but no branch or retained ref resolves for its latest started turn; ` +
        `invariant: a resume prompt names only the commit the resumed tree exposes; ` +
        `remedy: start a fresh keyed run from a known base with orch do ${launch?.job ?? '<job>'} ` +
        `--key ${launch?.launch_key ?? '<task key>'} --base <ref>`,
    )
  }
  const recentLog = worktree
    ? git(worktree, ['log', '--oneline', '--decorate=no', '--max-count=8'], {}).out
    : ''
  return renderCheckpointResumeContext({ startCommit, branch, checkpoint, recentLog })
}
