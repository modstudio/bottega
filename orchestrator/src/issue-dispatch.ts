// concern: filed-issue dispatch
/** Claims and bounds filed-issue coordinator passes. Does not diagnose or fix issues. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resolveRunsDirectory } from './database-location.ts'
import { db } from './db.ts'
import { parseFiledIssue, workIssue } from './issue.ts'
import {
  eligibleFiledIssueTasks,
  type FiledIssueTaskRow,
  filedIssueQueueStop,
  MAX_HELD_ISSUE_TREES,
  MAX_ISSUES_PER_PASS,
} from './issue-queue.ts'
import { type KernelLease, tryKernelLease } from './project-lock.ts'
import { worktreeDirty } from './worktree-attribution.ts'

const HUB = new URL('../../bin/hub', import.meta.url).pathname

type HeldIssueTree = { runId: number; path: string; why: string }

function leasePath(key: string): string {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(key)) throw new Error(`invalid task key ${key}`)
  return join(resolveRunsDirectory(), 'issue-leases', `${key}.lock`)
}

function liveLease(key: string): boolean {
  const path = leasePath(key)
  if (!existsSync(path)) return false
  const lease = tryKernelLease(path)
  if (!lease) return true
  lease.release()
  return false
}

function leaseHolder(key: string): string {
  try {
    const holder = JSON.parse(readFileSync(leasePath(key), 'utf8')) as { pid?: unknown }
    return typeof holder.pid === 'number' ? `pid ${holder.pid}` : 'an unknown process'
  } catch {
    return 'an unknown process'
  }
}

function acquireIssueLease(key: string): KernelLease | null {
  const path = leasePath(key)
  mkdirSync(join(resolveRunsDirectory(), 'issue-leases'), { recursive: true })
  const lease = tryKernelLease(path, true)
  if (lease)
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, since: new Date().toISOString() })}\n`,
    )
  return lease
}

async function hub(args: string[]): Promise<string> {
  const child = Bun.spawn([HUB, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `hub exited ${code}`)
  return stdout.trim()
}

async function task(key: string): Promise<{ task: FiledIssueTaskRow }> {
  return JSON.parse(await hub(['task', 'show', key, '--json']))
}

function claimable(shown: { task: FiledIssueTaskRow }, queueMode: boolean): boolean {
  const issue = parseFiledIssue(shown)
  if (queueMode && issue.kind !== 'defect') return false
  return shown.task.status_category === 'open' || shown.task.status_category === 'active'
}

async function claimAndWork(key: string, queueMode: boolean): Promise<boolean> {
  const lease = acquireIssueLease(key)
  if (!lease) {
    if (queueMode) return false
    throw new Error(
      `${key} is claimed by ${leaseHolder(key)}; check it with ps -p <pid> and retry after that process exits`,
    )
  }
  let claimed = false
  try {
    const shown = await task(key)
    if (!claimable(shown, queueMode)) {
      if (queueMode) return false
      throw new Error(
        `${key} is not claimable: expected a filed issue in open or stale active state`,
      )
    }
    await hub(['task', 'set', key, '--status', 'active'])
    claimed = true
    try {
      await workIssue(key)
      await hub(['task', 'set', key, '--status', 'review'])
      console.log(`${key} -> review`)
    } catch (cause) {
      try {
        await hub([
          'task',
          'comment',
          key,
          `Coordinator pass ended with error: ${String((cause as Error)?.message ?? cause)}`,
        ])
      } catch (recordCause) {
        console.error(
          `${key}: could not record the coordinator failure; task remains active: ${String((recordCause as Error)?.message ?? recordCause)}`,
        )
        throw recordCause
      }
      try {
        await hub(['task', 'set', key, '--status', 'review'])
      } catch (statusCause) {
        console.error(
          `${key}: could not move active issue to review: ${String((statusCause as Error)?.message ?? statusCause)}`,
        )
        throw statusCause
      }
      console.log(`${key} -> review (coordinator failed)`)
      throw cause
    }
    return true
  } finally {
    lease.release()
    if (!claimed && !queueMode) console.error(`${key}: claim was not taken`)
  }
}

function heldIssueTrees(): HeldIssueTree[] {
  const rows = db()
    .query(
      `SELECT id, worktree, keep_tree, keep_tree_reason, status FROM run
       WHERE job IN ('diagnose','issue-worker') AND worktree IS NOT NULL
         AND status IN ('ok','failed','stale','stopped') ORDER BY id`,
    )
    .all() as {
    id: number
    worktree: string
    keep_tree: number
    keep_tree_reason: string | null
    status: string
  }[]
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    if (seen.has(row.worktree) || !existsSync(row.worktree)) return []
    seen.add(row.worktree)
    const dirty = worktreeDirty(row.worktree)
    const why = row.keep_tree
      ? (row.keep_tree_reason ?? 'explicitly retained')
      : dirty.dirty
        ? dirty.detail
        : `terminal ${row.status} ${row.id} tree remains on disk`
    return [{ runId: row.id, path: row.worktree, why }]
  })
}

function printHeldStop(trees: HeldIssueTree[]): void {
  for (const tree of trees)
    console.log(`held issue tree: run ${tree.runId} ${tree.path} — ${tree.why}`)
  console.log(`stopped: ${MAX_HELD_ISSUE_TREES} held issue trees are already on disk`)
}

export async function dispatchFiledIssues(key?: string): Promise<void> {
  if (key) {
    await claimAndWork(key.toUpperCase(), false)
    return
  }
  const rows = JSON.parse(
    await hub(['task', 'list', '--project', PLATFORM_SLUG, '--json']),
  ) as FiledIssueTaskRow[]
  const candidates = eligibleFiledIssueTasks(rows, liveLease)
  const dispatched = new Set<string>()
  let taken = 0
  for (const candidate of candidates) {
    const trees = heldIssueTrees()
    const stop = filedIssueQueueStop(taken, trees.length)
    if (stop === 'held-tree-limit') {
      printHeldStop(trees)
      return
    }
    if (stop === 'issue-limit') {
      console.log(`stopped: reached the ${MAX_ISSUES_PER_PASS}-issue pass limit`)
      return
    }
    if (dispatched.has(candidate.key)) continue
    dispatched.add(candidate.key)
    if (await claimAndWork(candidate.key, true)) taken++
  }
  if (taken >= MAX_ISSUES_PER_PASS)
    console.log(`stopped: reached the ${MAX_ISSUES_PER_PASS}-issue pass limit`)
}

export async function waitingFiledIssues(): Promise<{ key: string; title: string | null }[]> {
  const rows = JSON.parse(
    await hub(['task', 'list', '--project', PLATFORM_SLUG, '--status', 'review', '--json']),
  ) as FiledIssueTaskRow[]
  return rows.flatMap((task) => {
    try {
      return parseFiledIssue({ task }).kind === 'defect'
        ? [{ key: task.key, title: task.title }]
        : []
    } catch {
      return []
    }
  })
}
