import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { nowIso } from './db.ts'
import { appendRunEvent } from './events.ts'
import { targetGitEnvironment } from './worktree.ts'

/**
 * A checkpoint is a delta folded into the next authored commit at landing.
 * Bytes captured while the worker is mid-write are corrected by the next
 * checkpoint or by the worker's own commit; checkpointing never locks the worker.
 */

export const PROGRESS_FILE_NAME = 'progress.json'
export const DEFAULT_CHECKPOINT_MINUTES = 10

export function progressFileInstruction(): string {
  return `CHECKPOINT PROGRESS\n\nThe harness checkpoints tracked changes for you. ` +
    `After completing an item, write {"task_pointer":"<last completed item>"} as valid JSON to ` +
    `$ORCH_SCRATCH/${PROGRESS_FILE_NAME}; the latest value is injected when a preserved run continues. ` +
    `You may rely on the harness to preserve staged and modified tracked work at limits and on stop.`
}

export function readTaskPointer(scratchDir: string): string | null {
  const path = join(scratchDir, PROGRESS_FILE_NAME)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { task_pointer?: unknown }
    return typeof value.task_pointer === 'string' && value.task_pointer.trim()
      ? value.task_pointer.trim().slice(0, 1000)
      : null
  } catch { return null }
}

function git(
  cwd: string, args: string[], guardEnvironment: NodeJS.ProcessEnv,
): { ok: boolean; out: string; error: string } {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...targetGitEnvironment(cwd), ...guardEnvironment }, stdout: 'pipe', stderr: 'pipe',
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

/** Commit staged and modified tracked files to exactly the current run branch. */
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
  const previous = input.database.query(
    'SELECT COALESCE(MAX(checkpoint_no),0) n FROM run_checkpoint WHERE run_id=?',
  ).get(input.runId) as { n: number }
  const checkpointNo = previous.n + 1
  const taskPointer = readTaskPointer(input.scratchDir)
  const refusal = (error: string): CheckpointResult => {
    appendRunEvent(input.runId, { ts: nowIso(), type: 'text', text: `checkpoint failed: ${error}` })
    return { created: false, commit: null, checkpointNo, taskPointer, error }
  }
  const dirty = git(input.worktree, ['status', '--porcelain', '--untracked-files=no'], input.guardEnvironment)
  if (!dirty.ok) return refusal(dirty.error)
  if (!dirty.out) return { created: false, commit: null, checkpointNo, taskPointer, error: null }
  const staged = git(input.worktree, ['add', '-u'], input.guardEnvironment)
  if (!staged.ok) return refusal(staged.error)
  // Adjacent to commit so the checked branch is the ref the commit will move.
  const currentBranch = git(input.worktree, ['symbolic-ref', '--short', 'HEAD'], input.guardEnvironment)
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
  input.database.query(
    `INSERT INTO run_checkpoint (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(input.runId, checkpointNo, commit.out, taskPointer, input.final ? 1 : 0, nowIso())
  return { created: true, commit: commit.out, checkpointNo, taskPointer, error: null }
}

export function latestCheckpoint(database: Database, rootId: number): {
  commit_sha: string; checkpoint_no: number; task_pointer: string | null
} | null {
  return database.query(
    `SELECT c.commit_sha,c.checkpoint_no,c.task_pointer
       FROM run_checkpoint c JOIN run r ON r.id=c.run_id
      WHERE r.id=? OR r.parent_run_id=? ORDER BY c.id DESC LIMIT 1`,
  ).get(rootId, rootId) as {
    commit_sha: string; checkpoint_no: number; task_pointer: string | null
  } | null
}

export function checkpointResumeContext(
  database: Database, rootId: number, worktree: string | null,
): string | null {
  const checkpoint = latestCheckpoint(database, rootId)
  if (!checkpoint) return null
  const log = worktree
    ? git(worktree, ['log', '--oneline', '--decorate=no', '--max-count=8'], {}).out
    : ''
  return [
    'CHECKPOINT RESUME',
    `Resume from checkpoint #${checkpoint.checkpoint_no} at ${checkpoint.commit_sha}.`,
    checkpoint.task_pointer ? `Last completed item: ${checkpoint.task_pointer}` : null,
    log ? `Recent branch history:\n${log}` : null,
  ].filter(Boolean).join('\n')
}
