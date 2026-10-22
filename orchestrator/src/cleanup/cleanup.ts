/** Cleanup knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { restoreBranch } from '../branch/branch-ref-guard.ts'
import { db, sessionId, writeTransaction } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import { repoRootOf, targetGitEnvironment } from '../git/git-environment.ts'
import { withCleanupLock as takeCleanupLock, withWorktreeLease } from '../project/project-lock.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { leakedResourceLines, resourcesForRuns } from '../resources/docker-resources.ts'
import { settleClaims } from '../resources/resource-claims.ts'
import {
  otherConversationWorktreeSharers,
  type WorktreeSharerRow,
} from '../resources/resource-ownership.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
  reauthorizeRunMutation,
} from '../run/run-authority.ts'
import { inspectTreeOwnership } from '../worktree/worktree-attribution.ts'
import { branchTip, removeBranch, removeFor, unmergedBranch } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { branchDeletableBy } from './branch-deletion-provenance.ts'
import {
  alreadyReleasedWorktreeLine,
  discardWorktreeAbsence,
} from './discard-worktree-absence.ts'

export type CleanupPresentation = {
  log: (...values: unknown[]) => void
  error: (...values: unknown[]) => void
  setExitCode: (code: number) => void
  keptBranchLine: (
    branch: string,
    uniqueCount: number,
    afterCutCount: number | null,
    id: string,
  ) => string
}
export type CleanupOptions = {
  force: boolean
  auditReason: string | null
  presentation: CleanupPresentation
  /** In-process only: eval-owned scratch is reclaimable. Not a CLI flag. */
  evalOwnedScratch?: boolean
}

export type CleanupRow = {
  record_id: string
  repo?: string | null
  cwd?: string | null
  worktree: string
  branch: string | null
  base_commit: string | null
  worktree_source?: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null
  minted_branch?: string | null
}

type BranchOwnerRow = {
  record_id: string
  repo: string | null
  cwd: string | null
  worktree: string | null
  status: string
  scored: number
  evidence_excluded?: string | null
}

class SharedWorktreeClaimError extends Error {
  readonly worktree: string
  readonly sharers: WorktreeSharerRow[]

  constructor(worktree: string, sharers: WorktreeSharerRow[]) {
    super(
      `worktree ${worktree} is still claimed by other conversations:\n` +
        sharers
          .map(
            (row) => `  run ${row.record_id} is ${row.status}${row.scored ? '' : ' and unscored'}`,
          )
          .join('\n'),
    )
    this.worktree = worktree
    this.sharers = sharers
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
  row: { record_id: string; repo?: string | null; branch: string | null },
  repoRoot: string,
  branchTipBeforeRemoval?: string | null,
): BranchOwnerRow[] {
  if (!row.branch) return []
  const project = row.repo ?? projectAt(repoRoot)?.name ?? null
  const candidates = db()
    .query(
      `SELECT r.record_id, COALESCE(r.parent_run_record_id, r.record_id) AS root_record_id,
            r.repo, r.cwd, r.worktree, r.status, r.evidence_excluded,
            ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
      WHERE r.branch=?
        AND COALESCE(r.parent_run_record_id, r.record_id) <>
            COALESCE((SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?), ?)
        AND r.status IN ('running','asking')
      ORDER BY r.record_id`,
    )
    .all(row.branch, row.record_id, row.record_id) as (BranchOwnerRow & {
    root_record_id: string
  })[]
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
  const roots = new Set<string>()
  return matching.flatMap((candidate) => {
    if (roots.has(candidate.root_record_id)) return []
    roots.add(candidate.root_record_id)
    return [{ ...candidate, record_id: candidate.root_record_id }]
  })
}

export function branchDeletionProvenanceRefusal(
  runId: string,
  target: string | null,
): string | null {
  const minted = db()
    .query(
      `SELECT record_id, minted_branch FROM run
       WHERE COALESCE(parent_run_record_id,record_id) =
             (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)
         AND minted_branch IS NOT NULL
       ORDER BY number`,
    )
    .all(runId) as { record_id: string; minted_branch: string }[]
  if (
    branchDeletableBy(
      target,
      minted.map((row) => row.minted_branch),
    )
  )
    return null
  const recordedMinter = target
    ? (db()
        .query('SELECT record_id FROM run WHERE minted_branch=? ORDER BY number LIMIT 1')
        .get(target) as {
        record_id: string
      } | null)
    : null
  const ownership = recordedMinter
    ? `it was minted by run ${recordedMinter.record_id}, not run ${runId}'s conversation`
    : `no recorded run minted it for run ${runId}'s conversation`
  return `branch ${target ?? '(none)'} cannot be deleted: ${ownership}; it was left in place`
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

/** Null this conversation's pointer for one tree. Clear close-out only when no tree pointer remains. */
function clearConversationWorktree(
  runId: string,
  worktree: string,
  keptBranch: string | null = null,
): void {
  db()
    .query(
      `UPDATE run
        SET worktree=NULL,
            branch_kept=CASE WHEN record_id=? THEN ? ELSE branch_kept END,
            branch_kept_tip=CASE WHEN record_id=? THEN NULL ELSE branch_kept_tip END
      WHERE worktree=?
        AND COALESCE(parent_run_record_id,record_id) =
            (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .run(runId, keptBranch, runId, worktree, runId)
  const remaining = db()
    .query(
      `SELECT 1 AS present FROM run
        WHERE worktree IS NOT NULL
          AND COALESCE(parent_run_record_id,record_id) =
              (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)
        LIMIT 1`,
    )
    .get(runId)
  if (remaining) return
  db()
    .query(
      `UPDATE run
        SET close_out_outcome=NULL,
            close_out_detail=NULL,
            close_out_attempted_at=NULL
      WHERE COALESCE(parent_run_record_id,record_id) =
            (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .run(runId)
}

export function resourcesForConversation(runId: string) {
  const ids = db()
    .query(
      `SELECT record_id FROM run
      WHERE COALESCE(parent_run_record_id,record_id) =
            (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .all(runId) as { record_id: string }[]
  return resourcesForRuns(ids.map((row) => row.record_id))
}

function recordRestoreRefusal(runId: string, branch: string, tip: string): void {
  db()
    .query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE record_id=?')
    .run(branch, tip, runId)
}

function restoreRefusal(runId: string, branch: string, tip: string, error: string): string {
  recordRestoreRefusal(runId, branch, tip)
  return (
    `branch ${branch} should have been restored to ${tip}, but the ref write was refused: ` +
    `${error}. Restore it from the main checkout.`
  )
}

function restoreRefusalError(runId: string, branch: string, tip: string, error: string): Error {
  return new Error(restoreRefusal(runId, branch, tip, error))
}

function branchOwnerMessage(branch: string, owner: BranchOwnerRow): string {
  return `branch ${branch} left because run ${owner.record_id} records it`
}

function liveTurnsMessage(live: { record_id: string; status: string; worktree: string | null }[]) {
  return live.map((turn) => `  run ${turn.record_id} (${turn.status}): ${turn.worktree}`).join('\n')
}

function sharedBranchRefusal(
  runId: string,
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
        `run ${owner.record_id} owns it, so it was left at ${after}`,
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
  runId: string,
  repoRoot: string,
  branch: string,
  snapshot: string | null,
  before: BranchOwnerRow[],
  after: BranchOwnerRow[],
): { refusal: string | null; warning: string | null } {
  const priorIds = new Set(before.map((owner) => owner.record_id))
  const acquired = after.find((owner) => !priorIds.has(owner.record_id)) ?? null
  const protector = acquired ?? after[0] ?? null
  let outcome = { refusal: null as string | null, warning: null as string | null }
  if (protector && snapshot) {
    outcome = sharedBranchRefusal(runId, repoRoot, branch, snapshot, protector)
  }
  if (!acquired) return outcome
  if (outcome.refusal) {
    return {
      refusal: `Run ${acquired.record_id} acquired branch ${branch} during cleanup; ${outcome.refusal}`,
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
      `Run ${acquired.record_id} acquired branch ${branch} during cleanup; cleanup was refused and the branch was ${location}.`,
    warning: null,
  }
}

/**
 * Release a run's worktree through the single path used by explicit cleanup.
 *
 * A WORKTREE NEED NOT BELONG TO ONE RUN, and assuming it did would have
 * deleted somebody's live work.
 *
 * orchestrator names its trees `orch-<id>`, but a project's own script names them
 * however it likes — one project's tool derives the directory from the TICKET KEY, so
 * every run carrying `--key STAR-5084` lands in the same directory. Four
 * runs (665, 666, 668, 669) shared one tree, three of them blocked and one
 * actively working in it, and `bottega run discard 665` would have removed the
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
    const found = db()
      .query(`SELECT minted_branch FROM run WHERE record_id=?`)
      .get(row.record_id) as {
      minted_branch: string | null
    } | null
    if (found?.minted_branch) return found.minted_branch
    const chained = db()
      .query(
        `SELECT minted_branch FROM run
        WHERE minted_branch IS NOT NULL AND (record_id=? OR parent_run_record_id=?)
        ORDER BY number LIMIT 1`,
      )
      .get(row.record_id, row.record_id) as { minted_branch: string | null } | null
    return chained?.minted_branch ?? null
  } catch {
    return null
  }
}

function assertDiscardTreeOwnership(row: CleanupRow, repoRoot: string, force: boolean): void {
  if (force || !existsSync(row.worktree)) return
  const conversationIds = (
    db()
      .query(
        `SELECT record_id FROM run
         WHERE COALESCE(parent_run_record_id,record_id) =
               (SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)
         ORDER BY number`,
      )
      .all(row.record_id) as { record_id: string }[]
  ).map((turn) => turn.record_id)
  const ownership = inspectTreeOwnership(row.worktree, repoRoot, conversationIds)
  if (ownership === 'attached') {
    throw new Error(
      `refusing to remove attached tree ${row.worktree}; ` +
        `clear this conversation's pointer with ${PLATFORM_SLUG} run close-out ${row.record_id}`,
    )
  }
  if (ownership === 'unknown') {
    throw new Error(
      `refusing to remove ${row.worktree}: ownership could not be established; ` +
        'inspect its .orch-run marker or retry with --force',
    )
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
  withCleanupLock(repoRoot, `${row.record_id}`, row.worktree, () => {
    assertDiscardTreeOwnership(row, repoRoot, force)
    const sharers = otherConversationWorktreeSharers(db(), row)
    if (sharers.length) {
      writeTransaction(() => {
        if (auditAuthority) {
          auditAuthority = reauthorizeRunMutation(auditAuthority, 'discard')
          auditAuthority = adoptRunMutation(auditAuthority, 'discard')
          auditRunMutation(auditAuthority, 'discard', options.auditReason)
        }
        clearConversationWorktree(row.record_id, row.worktree)
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
      row.record_id,
      force && !forceBusy,
    )
    const sharersAfter = otherConversationWorktreeSharers(db(), row)
    const ownersAfter = evidenceOwningBranchOwners(row, repoRoot, branchSnapshot)
    let branchWarning: string | null = null
    if (minted) {
      const ownership = verifyBranchOwnershipAfterCleanup(
        row.record_id,
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
          throw restoreRefusalError(row.record_id, minted, protectedBranch.tip, restored.error)
        }
        branchWarning =
          `project remove tool deleted protected branch ${minted}; ` +
          `restored ${protectedBranch.tip}`
      }
    }
    if (!r.removed) throw new Error(r.detail)
    if (!minted && row.branch) {
      options.presentation.log(
        `branch ${row.branch} kept (review subject, not owned by run ${row.record_id})`,
      )
    }
    if (branchWarning) options.presentation.error(branchWarning)
    const project = row.repo ?? projectAt(repoRoot)?.name ?? 'unknown'
    const inventory = resourcesForConversation(row.record_id)
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
    const forcedMintedBranchRemoved = mintedBranchWasRemoved(force, minted, repoRoot)
    writeTransaction(() => {
      if (auditAuthority) {
        auditAuthority = reauthorizeRunMutation(auditAuthority, 'discard')
        auditAuthority = adoptRunMutation(auditAuthority, 'discard')
      }
      clearConversationWorktree(row.record_id, row.worktree, keptProtectedBranch)
      settleClaims(db(), {
        rootRunId: row.record_id,
        kind: 'worktree',
        state: 'released',
        settledAt: new Date().toISOString(),
        detail: r.detail,
        allocationKey: row.worktree,
      })
      if (forcedMintedBranchRemoved && minted) {
        settleClaims(db(), {
          rootRunId: row.record_id,
          kind: 'branch',
          state: 'released',
          settledAt: new Date().toISOString(),
          detail: `deleted refs/heads/${minted}`,
          allocationKey: `refs/heads/${minted}`,
        })
      }
      if (auditAuthority) auditRunMutation(auditAuthority, 'discard', options.auditReason)
    })
    options.presentation.log(`${verb} run ${row.record_id}'s worktree`)
    if (r.output) options.presentation.log(r.output)
    if (protectedBranch && keptProtectedBranch) {
      options.presentation.log(
        options.presentation.keptBranchLine(
          keptProtectedBranch,
          protectedBranch.count,
          afterCutCount,
          row.record_id,
        ),
      )
    }
    const branchOwner = ownersAfter[0] ?? ownersBefore[0] ?? null
    if (branchOwner && row.branch) {
      options.presentation.log(branchOwnerMessage(row.branch, branchOwner))
    }
  })
}

function mintedBranchWasRemoved(force: boolean, branch: string | null, repoRoot: string): boolean {
  return Boolean(force && branch && branchTip(repoRoot, branch) === null)
}

/**
 * Delete a writing run's worktree and branch.
 *
 * Never automatic. A failed implementation run leaves the most readable
 * artifact in the system — a partial change set showing exactly how far the
 * worker got — and cleaning up on failure would destroy it at the moment it
 * is most wanted. Throwing the tree away is a decision someone makes after
 * reading the diff.
 *
 * The RUN ROW SURVIVES. Only the checkout goes: the routing evidence, the
 * score and the prompt are what the record is for, and a discarded experiment
 * still happened.
 */

function discardReclaimable(options: CleanupOptions): boolean {
  return options.force || options.evalOwnedScratch === true
}

export async function discardRun(id: string, options: CleanupOptions): Promise<void> {
  const force = discardReclaimable(options)
  let authority = authorizeRunMutation(id, 'discard')
  const rootRow = db()
    .query(
      `SELECT record_id, repo, cwd, worktree, branch, branch_kept, branch_kept_tip, base_commit,
              worktree_source, close_out_outcome
         FROM run WHERE record_id = ?`,
    )
    .get(authority.rootId) as {
    record_id: string
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    branch_kept: string | null
    branch_kept_tip: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
    close_out_outcome: string | null
  } | null
  if (!rootRow) throw new Error(`no run ${authority.rootId}`)
  const chain = db()
    .query(
      `SELECT record_id, status, worktree, branch, base_commit, worktree_source FROM run
        WHERE record_id = ? OR parent_run_record_id = ? ORDER BY turn, number`,
    )
    .all(authority.rootId, authority.rootId) as {
    record_id: string
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
          liveTurnsMessage(live),
      )
    }
    for (const worktree of worktrees) {
      const artifact = chain.find((turn) => turn.worktree === worktree)!
      discardWorktree(
        {
          record_id: authority.rootId,
          repo: rootRow.repo,
          cwd: rootRow.cwd,
          worktree,
          branch: artifact.branch ?? rootRow.branch,
          base_commit: artifact.base_commit ?? rootRow.base_commit,
          worktree_source: artifact.worktree_source ?? rootRow.worktree_source,
        },
        'discarded',
        force,
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
    if (!force || !row.branch_kept) {
      if (discardWorktreeAbsence(row.close_out_outcome) === 'already-released') {
        options.presentation.log(alreadyReleasedWorktreeLine(id))
        return
      }
      throw new Error(`run ${id} has no worktree to discard`)
    }
    const repoRoot = cleanupRepoRoot(row)
    if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
    withCleanupLock(repoRoot, `discard kept branch for run ${id}`, null, () => {
      const provenanceRefusal = branchDeletionProvenanceRefusal(row.record_id, row.branch_kept)
      if (provenanceRefusal) {
        writeTransaction(() => {
          authority = reauthorizeRunMutation(authority, 'discard')
          authority = adoptRunMutation(authority, 'discard')
          db()
            .query('UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE record_id=?')
            .run(authority.rootId)
          settleClaims(db(), {
            rootRunId: authority.rootId,
            kind: 'branch',
            state: 'released',
            settledAt: new Date().toISOString(),
            detail: `left refs/heads/${row.branch_kept}; branch was not minted by this conversation`,
            allocationKey: `refs/heads/${row.branch_kept}`,
          })
          auditRunMutation(authority, 'discard', options.auditReason)
        })
        options.presentation.log(provenanceRefusal)
        return
      }
      const ownerRow = { record_id: row.record_id, repo: row.repo, branch: row.branch_kept }
      const ownersBefore = evidenceOwningBranchOwners(ownerRow, repoRoot)
      if (ownersBefore.length) {
        throw new Error(
          `branch ${row.branch_kept} is still evidence owned by run ${ownersBefore[0]!.record_id}; ` +
            'it was left in place',
        )
      }
      authority = adoptRunMutation(authority, 'discard')
      const snapshot = branchTip(repoRoot, row.branch_kept!)
      // The snapshot is the tip cleanup classified when it decided to delete.
      const removed = removeBranch(repoRoot, row.branch_kept!, snapshot)
      const ownersAfter = evidenceOwningBranchOwners(ownerRow, repoRoot, snapshot)
      const outcome = verifyBranchOwnershipAfterCleanup(
        row.record_id,
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
          authority = reauthorizeRunMutation(authority, 'discard')
          authority = adoptRunMutation(authority, 'discard')
          db()
            .query('UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE record_id=?')
            .run(authority.rootId)
          settleClaims(db(), {
            rootRunId: authority.rootId,
            kind: 'branch',
            state: 'released',
            settledAt: new Date().toISOString(),
            detail: `deleted refs/heads/${row.branch_kept}`,
            allocationKey: `refs/heads/${row.branch_kept}`,
          })
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

  await discardWorktree(row as CleanupRow, 'discarded', force, authority, options)
  return
}
