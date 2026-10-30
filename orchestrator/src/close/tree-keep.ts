// concern: tree keep policy and observation
/** Decides whether recorded users of a tree require automatic close-out to keep it. */

import type { Database } from 'bun:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { db, liveRuns, nowIso } from '../database/db.ts'
import { hookTreeHoldDecision } from '../hook-tree/hook-tree.ts'
import { landingTreeHoldDecision } from '../landing-tree/landing-tree.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { openCursorWorktrees } from '../workflow/workflow-cursor-worktrees.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import type { ConversationKeepTreeHold } from './close-out-report.ts'

export type CloseOutIntent = 'terminal' | 'explicit' | 'sweep' | 'tree-remove'

export type TreeNamer =
  | { kind: 'cursor'; number: number; workflow: string; project: string }
  | { kind: 'live-run'; recordId: string }

export type TreeKeepDecision =
  | { action: 'proceed' }
  | { action: 'hold'; namers: TreeNamer[] }
  | { action: 'proceed-named'; namers: TreeNamer[] }

export function decideTreeKeep(input: {
  intent: CloseOutIntent
  namers: TreeNamer[]
}): TreeKeepDecision {
  if (input.namers.length === 0) return { action: 'proceed' }
  return input.intent === 'terminal' || input.intent === 'sweep'
    ? { action: 'hold', namers: input.namers }
    : { action: 'proceed-named', namers: input.namers }
}

export function treeNamersText(namers: readonly TreeNamer[]): string {
  return namers
    .map((namer) =>
      namer.kind === 'cursor'
        ? `open workflow cursor ${namer.number} (${namer.workflow}, ${namer.project})`
        : `live run ${namer.recordId}`,
    )
    .join(', ')
}

function realTreePath(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function treeKeepNamers(
  path: string,
  conversationRootId: string,
  database: Database = db(),
): TreeNamer[] {
  const canonical = realTreePath(path)
  if (!canonical) return []
  const namers: TreeNamer[] = []
  for (const cursor of openCursorWorktrees(database)) {
    if (realTreePath(cursor.worktree) !== canonical) continue
    namers.push({
      kind: 'cursor',
      number: cursor.number,
      workflow: cursor.workflow,
      project: cursor.project,
    })
  }
  for (const run of liveRuns(database)) {
    if (run.rootRecordId === conversationRootId || !run.worktree) continue
    if (realTreePath(run.worktree) !== canonical) continue
    namers.push({ kind: 'live-run', recordId: run.recordId })
  }
  return namers
}

/** Canonical paths named by an open cursor or live run for one project. */
export function namedProjectTreePaths(project: string, database: Database = db()): Set<string> {
  const candidates = new Set<string>()
  for (const cursor of openCursorWorktrees(database)) {
    if (cursor.project === project) candidates.add(cursor.worktree)
  }
  for (const run of liveRuns(database)) {
    if (run.project === project && run.worktree) candidates.add(run.worktree)
  }
  const named = new Set<string>()
  for (const path of candidates) {
    const canonical = realTreePath(path)
    if (canonical && treeKeepNamers(canonical, '', database).length > 0) named.add(canonical)
  }
  return named
}

export function conversationKeepTreeHold(
  rootId: string,
  now: string = nowIso(),
  database: Database = db(),
): ConversationKeepTreeHold {
  const rows = database
    .query(
      `SELECT job,keep_tree,keep_tree_until,keep_tree_reason,started_at,worktree,branch FROM run
       WHERE record_id=? OR parent_run_record_id=? ORDER BY number`,
    )
    .all(rootId, rootId) as {
    job: string
    keep_tree: number
    keep_tree_until: string | null
    keep_tree_reason: string | null
    started_at: string
    worktree: string | null
    branch: string | null
  }[]
  const treeExists = rows.some((row) => row.worktree !== null && existsSync(row.worktree))
  const expired: { held: false; expiredAt: string }[] = []
  for (const row of rows) {
    const decision = keepTreeHold({
      keepTree: row.keep_tree,
      keepTreeUntil: row.keep_tree_until,
      startedAt: row.started_at,
      now,
    })
    if (decision.held) {
      return landingTreeHoldDecision(
        { job: row.job, treeExists, branch: row.branch, runId: rootId },
        !row.worktree || !existsSync(row.worktree) || !worktreeDirty(row.worktree).dirty,
        hookTreeHoldDecision(
          { job: row.job, treeExists },
          { ...decision, reason: row.keep_tree_reason ?? 'explicit --keep-tree' },
        ),
      )
    }
    if ('expiredAt' in decision) expired.push(decision)
  }
  const latest = expired.sort((a, b) => Date.parse(b.expiredAt) - Date.parse(a.expiredAt))[0]
  const hook = rows.some((row) => row.job === HOOK_TREE_JOB) ? HOOK_TREE_JOB : ''
  const landingRows = rows.filter((row) => row.job === LANDING_TREE_JOB)
  return landingTreeHoldDecision(
    {
      job: landingRows[0]?.job ?? '',
      treeExists,
      branch: landingRows[0]?.branch ?? null,
      runId: rootId,
    },
    landingRows
      .filter((row) => row.worktree && existsSync(row.worktree))
      .every((row) => !worktreeDirty(row.worktree!).dirty),
    hookTreeHoldDecision({ job: hook, treeExists }, latest ?? { held: false as const }),
  )
}

export function closeOutKeepTreeDecision(
  rootId: string,
  treePath: string | null,
  intent: CloseOutIntent,
  database: Database = db(),
): { hold: ConversationKeepTreeHold; naming: TreeKeepDecision } {
  const namers = treePath ? treeKeepNamers(treePath, rootId, database) : []
  const naming = decideTreeKeep({ intent, namers })
  if (naming.action === 'hold') {
    return {
      hold: {
        held: true,
        until: null,
        reason: `tree kept because ${treeNamersText(naming.namers)} names it`,
      },
      naming,
    }
  }
  if (intent === 'tree-remove') return { hold: { held: false }, naming }
  if (intent === 'sweep') {
    const landing = database
      .query(
        'SELECT 1 present FROM run WHERE (record_id=? OR parent_run_record_id=?) AND job=? LIMIT 1',
      )
      .get(rootId, rootId, LANDING_TREE_JOB)
    if (landing) return { hold: { held: false }, naming }
  }
  return { hold: conversationKeepTreeHold(rootId, nowIso(), database), naming }
}
