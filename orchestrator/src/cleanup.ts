/** Cleanup knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { db, sessionId, writeTransaction } from './db.ts'
import { leakedResourceLines, resourcesForRuns } from './docker-resources.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from './evidence-query.ts'
import { repoRootOf, targetGitEnvironment } from './git-environment.ts'
import { withCleanupLock as takeCleanupLock, withWorktreeLease } from './project-lock.ts'
import { projectAt, projectByName } from './projects.ts'
import { otherConversationWorktreeSharers, type WorktreeSharerRow } from './resource-ownership.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
} from './run-authority.ts'
import {
  branchTip,
  removeBranch,
  removeFor,
  restoreBranch,
  unmergedBranch,
} from './worktree-remove.ts'
import type { Worktree } from './worktree-types.ts'

export type CleanupPresentation = {
  log: (...values: unknown[]) => void
  error: (...values: unknown[]) => void
  setExitCode: (code: number) => void
  keptBranchLine: (
    branch: string,
    uniqueCount: number,
    afterCutCount: number | null,
    id: number,
  ) => string
}
export type CleanupOptions = {
  force: boolean
  auditReason: string | null
  presentation: CleanupPresentation
}

export type CleanupRow = {
  id: number
  repo?: string | null
  cwd?: string | null
  worktree: string
  branch: string | null
  base_commit: string | null
  worktree_source?: 'recipe' | 'git' | 'readonly_recipe' | null
  minted_branch?: string | null
}

type BranchOwnerRow = {
  id: number
  repo: string | null
  cwd: string | null
  worktree: string | null
  status: string
  scored: number
  evidence_excluded?: string | null
}

class SharedWorktreeClaimError extends Error {
  constructor(
    readonly worktree: string,
    readonly sharers: WorktreeSharerRow[],
  ) {
    super(
      `worktree ${worktree} is still claimed by other conversations:\n` +
        sharers
          .map((row) => `  run ${row.id} is ${row.status}${row.scored ? '' : ' and unscored'}`)
          .join('\n'),
    )
  }
}
export function cleanupRepoRoot(row: {
  worktree?: string | null
  cwd?: string | null
  repo?: string | null
}): string | null {
  const registered = row.repo ? projectByName(row.repo)?.path : null
  const builtInRoot = row.worktree?.includes('/.claude/worktrees/')
    ? row.worktree.slice(0, row.worktree.indexOf('/.claude/worktrees/'))
    : null
  return (
    registered ??
    repoRootOf(row.worktree ?? '') ??
    repoRootOf(row.cwd ?? '') ??
    (builtInRoot ? repoRootOf(builtInRoot) : null) ??
    repoRootOf(process.cwd())
  )
}

function samePath(a: string, b: string): boolean {
  const normalized = (path: string) => {
    const value = existsSync(path) ? realpathSync(path) : resolve(path)
    return value.replace(/\/$/, '')
  }
  return normalized(a) === normalized(b)
}

/** A branch is shared only inside one repository, and active owners protect it. */
export function evidenceOwningBranchOwners(
  row: { id: number; repo?: string | null; branch: string | null },
  repoRoot: string,
  branchTipBeforeRemoval?: string | null,
): BranchOwnerRow[] {
  if (!row.branch) return []
  const project = row.repo ?? projectAt(repoRoot)?.name ?? null
  const candidates = db()
    .query(
      `SELECT r.id, COALESCE(r.parent_run_id, r.id) AS root_id,
            r.repo, r.cwd, r.worktree, r.status, r.evidence_excluded,
            ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
      WHERE r.branch=?
        AND COALESCE(r.parent_run_id, r.id) <>
            COALESCE((SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?), ?)
        AND r.status IN ('running','asking')
      ORDER BY r.id`,
    )
    .all(row.branch, row.id, row.id) as (BranchOwnerRow & { root_id: number })[]
  const matching = candidates.filter((candidate) => {
    if (project && candidate.repo && candidate.repo !== project) return false
    const candidateRoot = candidate.repo ? projectByName(candidate.repo)?.path : null
    const discovered =
      candidateRoot ?? repoRootOf(candidate.worktree ?? '') ?? repoRootOf(candidate.cwd ?? '')
    if (!discovered || !samePath(discovered, repoRoot)) return false
    if ((candidate.status === 'failed' || candidate.evidence_excluded) && candidate.repo) {
      const trunk = projectByName(candidate.repo)?.settings.trunk
      if (typeof trunk === 'string') {
        const cherry = Bun.spawnSync(
          ['git', 'cherry', trunk, branchTipBeforeRemoval ?? row.branch!],
          {
            cwd: repoRoot,
            env: targetGitEnvironment(repoRoot),
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        if (cherry.exitCode === 0) {
          const commits = cherry.stdout.toString().trim().split('\n').filter(Boolean)
          if (commits.every((line) => line.startsWith('-'))) return false
        }
      }
    }
    return true
  })
  const roots = new Set<number>()
  return matching.flatMap((candidate) => {
    if (roots.has(candidate.root_id)) return []
    roots.add(candidate.root_id)
    return [{ ...candidate, id: candidate.root_id }]
  })
}

export function withCleanupLock<T>(
  repoRoot: string,
  what: string,
  worktreePath: string | null | undefined,
  action: () => T,
): T {
  const run = () =>
    takeCleanupLock(repoRoot, { session: sessionId(), what: `cleanup ${what}` }, action, 5 * 60_000)
  if (!worktreePath) return run()
  return withWorktreeLease(
    repoRoot,
    worktreePath,
    { session: sessionId(), what: `tree ${what}` },
    run,
    5 * 60_000,
  )
}

/** One removed tree clears every pointer held by the same conversation. */
function clearConversationWorktree(
  runId: number,
  worktree: string,
  keptBranch: string | null = null,
): void {
  db()
    .query(
      `UPDATE run
        SET worktree=NULL,
            branch_kept=CASE WHEN id=? THEN ? ELSE branch_kept END,
            branch_kept_tip=CASE WHEN id=? THEN NULL ELSE branch_kept_tip END
      WHERE worktree=?
        AND COALESCE(parent_run_id, id) =
            (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
    )
    .run(runId, keptBranch, runId, worktree, runId)
}

export function resourcesForConversation(runId: number) {
  const ids = db()
    .query(
      `SELECT id FROM run
      WHERE COALESCE(parent_run_id, id) =
            (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
    )
    .all(runId) as { id: number }[]
  return resourcesForRuns(ids.map((row) => row.id))
}

function recordRestoreRefusal(runId: number, branch: string, tip: string): void {
  db().query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?').run(branch, tip, runId)
}

function restoreRefusal(runId: number, branch: string, tip: string, error: string): string {
  recordRestoreRefusal(runId, branch, tip)
  return (
    `branch ${branch} should have been restored to ${tip}, but the ref write was refused: ` +
    `${error}. Restore it from the main checkout.`
  )
}

function sharedBranchRefusal(
  runId: number,
  repoRoot: string,
  branch: string,
  snapshot: string,
  owner: BranchOwnerRow,
): { refusal: string | null; warning: string | null } {
  const after = branchTip(repoRoot, branch)
  if (after === snapshot) return { refusal: null, warning: null }
  if (after !== null) {
    return {
      refusal:
        `shared branch ${branch} moved from ${snapshot} to ${after} during cleanup; ` +
        `run ${owner.id} owns it, so it was left at ${after}`,
      warning: null,
    }
  }
  const restored = restoreBranch(repoRoot, branch, snapshot)
  return restored.ok
    ? {
        refusal: null,
        warning:
          `project remove tool deleted shared branch ${branch}; restored ${snapshot}. ` +
          'The tip at deletion was not observable.',
      }
    : {
        refusal: restoreRefusal(runId, branch, snapshot, restored.error),
        warning: null,
      }
}

export function verifyBranchOwnershipAfterCleanup(
  runId: number,
  repoRoot: string,
  branch: string,
  snapshot: string | null,
  before: BranchOwnerRow[],
  after: BranchOwnerRow[],
): { refusal: string | null; warning: string | null } {
  const priorIds = new Set(before.map((owner) => owner.id))
  const acquired = after.find((owner) => !priorIds.has(owner.id)) ?? null
  const protector = acquired ?? after[0] ?? null
  let outcome = { refusal: null as string | null, warning: null as string | null }
  if (protector && snapshot) {
    outcome = sharedBranchRefusal(runId, repoRoot, branch, snapshot, protector)
  }
  if (!acquired) return outcome
  if (outcome.refusal) {
    return {
      refusal: `Run ${acquired.id} acquired branch ${branch} during cleanup; ${outcome.refusal}`,
      warning: null,
    }
  }
  const current = branchTip(repoRoot, branch)
  const location = current
    ? `left at ${current}`
    : 'absent with no pre-cleanup tip available to restore'
  return {
    refusal:
      `${outcome.warning ? `${outcome.warning} ` : ''}` +
      `Run ${acquired.id} acquired branch ${branch} during cleanup; cleanup was refused and the branch was ${location}.`,
    warning: null,
  }
}

/**
 * Release a run's worktree through the single path used by explicit cleanup.
 *
 * A WORKTREE NEED NOT BELONG TO ONE RUN, and assuming it did would have
 * deleted somebody's live work.
 *
 * orch names its trees `orch-<id>`, but a project's own script names them
 * however it likes — one project's tool derives the directory from the TICKET KEY, so
 * every run carrying `--key STAR-5084` lands in the same directory. Four
 * runs (665, 666, 668, 669) shared one tree, three of them blocked and one
 * actively working in it, and `orch discard 665` would have removed the
 * directory out from under run 669 mid-task. It was also that task's own
 * worktree, seeded, not a throwaway.
 *
 * So the tree goes only when no other conversation still points at it. A
 * refusal releases the discarding conversation's pointer under the cleanup
 * lock, so another conversation may retry only after every sibling has
 * explicitly relinquished ownership.
 *
 * The repo root is resolved from the worktree when it still exists, and
 * from HERE when it does not — `repoRootOf` on a deleted directory can
 * answer nothing, and the prune still needs somewhere to run. The pointer is
 * cleared ONLY if the tree actually went: clearing it after a failed removal
 * orphans the directory, still on disk, no longer named by any run, and
 * nothing left that knows to try again.
 */
function mintedBranchForCleanup(row: CleanupRow): string | null {
  if (row.minted_branch) return row.minted_branch
  try {
    const found = db().query(`SELECT minted_branch FROM run WHERE id=?`).get(row.id) as {
      minted_branch: string | null
    } | null
    if (found?.minted_branch) return found.minted_branch
    const chained = db()
      .query(
        `SELECT minted_branch FROM run
        WHERE minted_branch IS NOT NULL AND (id=? OR parent_run_id=?)
        ORDER BY id LIMIT 1`,
      )
      .get(row.id, row.id) as { minted_branch: string | null } | null
    return chained?.minted_branch ?? null
  } catch {
    return null
  }
}

export function discardWorktree(
  row: CleanupRow,
  verb: 'discarded' | 'abandoned',
  force = false,
  auditAuthority: RootAuthority | undefined,
  options: CleanupOptions,
  forceBusy = false,
): void {
  const repoRoot = cleanupRepoRoot(row) ?? process.cwd()
  withCleanupLock(repoRoot, `${row.id}`, row.worktree, () => {
    const sharers = otherConversationWorktreeSharers(db(), row)
    if (sharers.length) {
      writeTransaction(() => {
        clearConversationWorktree(row.id, row.worktree)
        if (auditAuthority) {
          auditAuthority = adoptRunMutation(auditAuthority, 'discard')
          auditRunMutation(auditAuthority, 'discard', options.auditReason)
        }
      })
      const claim = new SharedWorktreeClaimError(row.worktree, sharers)
      claim.message +=
        `\nthis conversation's pointer on ${row.worktree} was released; ` +
        'the tree will be collectable once the remaining pointers are released'
      throw claim
    }

    const minted = mintedBranchForCleanup(row)
    const ownersBefore = evidenceOwningBranchOwners(row, repoRoot)
    const branchSnapshot = minted ? branchTip(repoRoot, minted) : null
    let protectedBranch: ReturnType<typeof unmergedBranch> = null
    let afterCutCount: number | null = null
    if (!force && minted) {
      protectedBranch = unmergedBranch(repoRoot, minted, null)
      afterCutCount = row.base_commit
        ? (unmergedBranch(repoRoot, minted, row.base_commit)?.count ?? 0)
        : null
    }
    if (auditAuthority) auditAuthority = adoptRunMutation(auditAuthority, 'discard')
    const r = removeFor(
      {
        path: row.worktree,
        branch: minted ?? '',
        base: row.base_commit ?? '',
        repoRoot,
        source: row.worktree_source ?? undefined,
        mintedBranch: minted,
      },
      repoRoot,
      force || forceBusy,
      ownersBefore.length > 0 || !minted,
      row.id,
      force && !forceBusy,
    )
    const sharersAfter = otherConversationWorktreeSharers(db(), row)
    const ownersAfter = evidenceOwningBranchOwners(row, repoRoot, branchSnapshot)
    let branchWarning: string | null = null
    if (minted) {
      const ownership = verifyBranchOwnershipAfterCleanup(
        row.id,
        repoRoot,
        minted,
        branchSnapshot,
        ownersBefore,
        ownersAfter,
      )
      if (ownership.refusal) throw new Error(ownership.refusal)
      branchWarning = ownership.warning
    }
    if (sharersAfter.length) {
      const claim = new SharedWorktreeClaimError(row.worktree, sharersAfter)
      claim.message =
        `another conversation claimed ${row.worktree} during cleanup; ` +
        `the tree has already been removed and this conversation's pointer was not released.\n` +
        `${claim.message}\nResolve the listed conversations' stale pointers, then retry this cleanup.`
      throw claim
    }
    if (protectedBranch && minted && ownersBefore.length === 0 && ownersAfter.length === 0) {
      const after = branchTip(repoRoot, minted)
      if (after !== null && after !== protectedBranch.tip) {
        throw new Error(
          `protected branch ${minted} moved from ${protectedBranch.tip} to ${after} during cleanup; ` +
            `it was left at ${after}`,
        )
      }
      if (after === null) {
        const restored = restoreBranch(repoRoot, minted, protectedBranch.tip)
        if (!restored.ok) {
          throw new Error(restoreRefusal(row.id, minted, protectedBranch.tip, restored.error))
        }
        branchWarning =
          `project remove tool deleted protected branch ${minted}; ` +
          `restored ${protectedBranch.tip}`
      }
    }
    if (!r.removed) throw new Error(r.detail)
    if (!minted && row.branch) {
      options.presentation.log(
        `branch ${row.branch} kept (review subject, not owned by run ${row.id})`,
      )
    }
    if (branchWarning) options.presentation.error(branchWarning)
    const project = row.repo ?? projectAt(repoRoot)?.name ?? 'unknown'
    const inventory = resourcesForConversation(row.id)
    if (!inventory.ascertainable) {
      throw new Error(
        `project ${project}'s cleanup could not be verified — inventory unavailable:\n` +
          `  ${inventory.reason}`,
      )
    }
    if (inventory.resources.length) {
      throw new Error(
        `project ${project}'s remove tool left Docker resources behind:\n` +
          leakedResourceLines(inventory.resources, project)
            .map((line) => `  ${line}`)
            .join('\n'),
      )
    }
    const keptProtectedBranch =
      protectedBranch && row.branch && branchTip(repoRoot, row.branch) ? row.branch : null
    writeTransaction(() => {
      clearConversationWorktree(row.id, row.worktree, keptProtectedBranch)
      if (auditAuthority) auditRunMutation(auditAuthority, 'discard', options.auditReason)
    })
    options.presentation.log(`${verb} run ${row.id}'s worktree`)
    if (r.output) options.presentation.log(r.output)
    if (protectedBranch && keptProtectedBranch) {
      options.presentation.log(
        options.presentation.keptBranchLine(
          keptProtectedBranch,
          protectedBranch.count,
          afterCutCount,
          row.id,
        ),
      )
    }
    const branchOwner = ownersAfter[0] ?? ownersBefore[0] ?? null
    if (branchOwner && row.branch) {
      options.presentation.log(`branch ${row.branch} left because run ${branchOwner.id} records it`)
    }
  })
}

/**
 * Delete a writing run's worktree and branch.
 *
 * Never automatic. A failed implementation run leaves the most readable
 * artefact in the system — a partial change set showing exactly how far the
 * worker got — and cleaning up on failure would destroy it at the moment it
 * is most wanted. Throwing the tree away is a decision someone makes after
 * reading the diff.
 *
 * The RUN ROW SURVIVES. Only the checkout goes: the routing evidence, the
 * score and the prompt are what the record is for, and a discarded experiment
 * still happened.
 */

export async function discardRun(id: number, options: CleanupOptions): Promise<void> {
  let authority = authorizeRunMutation(id, 'discard')
  const rootRow = db()
    .query(
      `SELECT id, repo, cwd, worktree, branch, branch_kept, branch_kept_tip, base_commit,
              worktree_source
         FROM run WHERE id = ?`,
    )
    .get(authority.rootId) as {
    id: number
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    branch_kept: string | null
    branch_kept_tip: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
  } | null
  if (!rootRow) throw new Error(`no run ${authority.rootId}`)
  const chain = db()
    .query(
      `SELECT id, status, worktree, branch, base_commit, worktree_source FROM run
        WHERE id = ? OR parent_run_id = ? ORDER BY turn, id`,
    )
    .all(authority.rootId, authority.rootId) as {
    id: number
    status: string
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
  }[]
  const worktrees = [...new Set(chain.flatMap((turn) => (turn.worktree ? [turn.worktree] : [])))]
  if (worktrees.length > 1) {
    const live = chain.filter(
      (turn) => turn.worktree && ['running', 'asking'].includes(turn.status),
    )
    if (live.length) {
      throw new Error(
        `refusing to discard chain ${authority.rootId}: live turns still own worktrees:\n` +
          live.map((turn) => `  run ${turn.id} (${turn.status}): ${turn.worktree}`).join('\n'),
      )
    }
    for (const worktree of worktrees) {
      const artifact = chain.find((turn) => turn.worktree === worktree)!
      discardWorktree(
        {
          id: authority.rootId,
          repo: rootRow.repo,
          cwd: rootRow.cwd,
          worktree,
          branch: artifact.branch ?? rootRow.branch,
          base_commit: artifact.base_commit ?? rootRow.base_commit,
          worktree_source: artifact.worktree_source ?? rootRow.worktree_source,
        },
        'discarded',
        options.force,
        authority,
        options,
      )
    }
    return
  }
  const artifact = chain.find((turn) => turn.worktree === worktrees[0])
  const row = {
    ...rootRow,
    worktree: worktrees[0] ?? null,
    branch: rootRow.branch ?? artifact?.branch ?? null,
    base_commit: rootRow.base_commit ?? artifact?.base_commit ?? null,
    worktree_source: rootRow.worktree_source ?? artifact?.worktree_source ?? null,
  }
  if (!row.worktree) {
    if (!options.force || !row.branch_kept) {
      throw new Error(`run ${id} has no worktree to discard`)
    }
    const repoRoot = cleanupRepoRoot(row)
    if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
    withCleanupLock(repoRoot, `discard kept branch for run ${id}`, null, () => {
      const ownerRow = { id: row.id, repo: row.repo, branch: row.branch_kept }
      const ownersBefore = evidenceOwningBranchOwners(ownerRow, repoRoot)
      if (ownersBefore.length) {
        throw new Error(
          `branch ${row.branch_kept} is still evidence owned by run ${ownersBefore[0]!.id}; ` +
            'it was left in place',
        )
      }
      authority = adoptRunMutation(authority, 'discard')
      const snapshot = branchTip(repoRoot, row.branch_kept!)
      const removed = removeBranch(repoRoot, row.branch_kept!)
      const ownersAfter = evidenceOwningBranchOwners(ownerRow, repoRoot, snapshot)
      const outcome = verifyBranchOwnershipAfterCleanup(
        row.id,
        repoRoot,
        row.branch_kept!,
        snapshot,
        ownersBefore,
        ownersAfter,
      )
      if (outcome.refusal) throw new Error(outcome.refusal)
      if (outcome.warning) options.presentation.error(outcome.warning)
      if (removed) {
        writeTransaction(() => {
          db()
            .query('UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE id=?')
            .run(authority.rootId)
          auditRunMutation(authority, 'discard', options.auditReason)
        })
      }
      options.presentation.log(
        removed
          ? `deleted branch ${row.branch_kept}`
          : `branch ${row.branch_kept} cleanup skipped: branch does not exist`,
      )
    })
    return
  }

  await discardWorktree(row as CleanupRow, 'discarded', options.force, authority, options)
  return
}
