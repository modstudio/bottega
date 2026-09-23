import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { branchRows, type ReclaimRun, settleDeletedBranch } from '../branch/branch-settlement.ts'
import type { BranchLanding } from '../branch/branch-state.ts'
import { classifyMintedBranch } from '../branch/branches.ts'
import { db, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import {
  withCleanupLock,
  withWorktreeCreateLock,
  withWorktreeLease,
} from '../project/project-lock.ts'
import { projectAt, projectByName, resolvedWorktreeTool } from '../project/projects.ts'
import { settleClaims } from '../resources/resource-claims.ts'
import { otherConversationWorktreeSharers } from '../resources/resource-ownership.ts'
import { runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import {
  markedWorktreeSource,
  orphanSafety,
  worktreeDirty,
} from '../worktree/worktree-attribution.ts'
import { branchTip, removeFor, restoreBranch } from '../worktree/worktree-remove.ts'
import { reclaimDirtyTreeRefusal } from './reclaim-worktree-dirty.ts'

export type ReclaimResult = { ok: boolean; action: string }

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    ok: result.exitCode === 0,
    out: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
  }
}

function refuse(missing: string): ReclaimResult {
  return { ok: false, action: `refused; ${missing}` }
}

function runRows(path: string): ReclaimRun[] {
  const rows = db()
    .query(
      `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id, r.repo, r.worktree,
            r.branch, r.branch_kept, r.branch_kept_tip, r.minted_branch,
            r.base_commit, r.worktree_source, r.status,
            r.pid, r.agent_pid, r.session_id, seen.last_seen session_last_seen,
            ${EVIDENCE_CLOSED_SQL} AS scored, r.keep_tree, r.keep_tree_until, r.started_at
       FROM run r ${chainScoreJoin('r', 's')}
       LEFT JOIN session_seen seen ON seen.session_id=r.session_id
      WHERE r.worktree IS NOT NULL ORDER BY r.id`,
    )
    .all() as ReclaimRun[]
  const canonical = (candidate: string) => {
    try {
      return existsSync(candidate) ? realpathSync(candidate) : resolve(candidate)
    } catch {
      return resolve(candidate)
    }
  }
  const wanted = canonical(path)
  return rows.filter((row) => canonical(row.worktree) === wanted)
}

function liveOwner(row: ReclaimRun): string | null {
  return runAlive({
    status: row.status,
    lease: runLeaseState(row.id),
    pidAlive: Boolean(row.pid && pidAlive(row.pid)),
  })
    ? `run ${row.id} is alive`
    : null
}

function absentCommits(repoRoot: string, subject: string, trunk: string): string[] | null {
  const result = git(repoRoot, ['rev-list', subject, '--not', trunk])
  return result.ok ? result.out.split('\n').filter(Boolean) : null
}

export function decideBranchReclaimEvidence(input: {
  absentCommits: readonly string[]
  classification: BranchLanding['state']
}): { allowed: true; proof: string } | { allowed: false; state: BranchLanding['state'] } {
  if (input.absentCommits.length === 0) return { allowed: true, proof: 'reachable' }
  if (['landed', 'superseded', 'empty'].includes(input.classification)) {
    return { allowed: true, proof: input.classification }
  }
  return { allowed: false, state: input.classification }
}

type WorktreeProof = {
  result: ReclaimResult
  rows?: ReclaimRun[]
  project?: NonNullable<ReturnType<typeof projectByName>>
}

function proveRunOwners(
  rows: ReclaimRun[],
  includeRecordedProcessLiveness = true,
): ReclaimResult | null {
  for (const row of rows) {
    if (includeRecordedProcessLiveness) {
      const live = liveOwner(row)
      if (live) return refuse(live)
    }
    if (!['ok', 'failed', 'stale', 'stopped'].includes(row.status)) {
      return refuse(`run ${row.id} status ${row.status} is not terminal`)
    }
  }
  return null
}

function fullClaimRefusal(path: string, runId: number): ReclaimResult | null {
  const sharers = otherConversationWorktreeSharers(db(), {
    id: runId,
    worktree: path,
  })
  if (!sharers.length) return null
  return refuse(
    `worktree ${path} is still claimed by other conversation(s): ` +
      sharers.map((row) => `run ${row.id} (${row.status})`).join(', '),
  )
}

function existingTreeGitRefusal(path: string, repoRoot: string): ReclaimResult | null {
  if (!existsSync(path)) return null
  const safety = orphanSafety(path, repoRoot, '')
  if (!safety.removable) {
    return refuse(`worktree safety could not be proved: ${safety.detail}`)
  }
  return reclaimDirtyTreeRefusal({
    path,
    treeExists: true,
    dirty: worktreeDirty(path),
  })
}

function proveWorktree(path: string, clock: number, _allowDirty = false): WorktreeProof {
  const rows = runRows(path)
  const row = rows[0]
  const project = row?.repo ? projectByName(row.repo) : projectAt(path)
  if (!project) return { result: refuse(`worktree ${path} has no registered project`) }
  const registeredPath = realpathSync(project.path)
  if (path === registeredPath) {
    return {
      result: refuse(`worktree ${path} is the project's registered checkout`),
    }
  }
  const worktreesRoot = resolve(registeredPath, '.claude', 'worktrees')
  const fromRoot = relative(worktreesRoot, path)
  // The exact registered checkout has its own refusal above. Keeping it out of
  // this predicate makes each destructive guard independently defeat-testable.
  if (
    path !== registeredPath &&
    (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
  ) {
    return {
      result: refuse(
        `worktree ${path} is not beneath project worktrees directory ${worktreesRoot}`,
      ),
    }
  }
  if (rows.length) {
    const owners = proveRunOwners(rows, false)
    if (owners) return { result: owners }
    for (const lockedRow of rows) {
      if (
        keepTreeHold({
          keepTree: lockedRow.keep_tree,
          keepTreeUntil: lockedRow.keep_tree_until,
          startedAt: lockedRow.started_at,
          now: new Date(clock).toISOString(),
        }).held
      )
        return {
          result: refuse(`run ${lockedRow.id} records keep_tree; its worktree is protected`),
        }
    }
  }
  const gitRefusal = existingTreeGitRefusal(path, project.path)
  if (gitRefusal) return { result: gitRefusal }
  if (!row && resolvedWorktreeTool(project)?.recipePath) {
    return {
      result: refuse(
        'tracked recipe tree has no recorded recipe snapshot; teardown cannot be established',
      ),
    }
  }
  return {
    result: {
      ok: true,
      action: `would reclaim worktree ${path}; committed work is retained by its branch`,
    },
    rows,
    project,
  }
}

/** Prove containment, terminal ownership, retention, and git state without answering liveness or claim questions. */
export function proveWorktreeReconstructible(
  requestedPath: string,
  options: { clock?: number; allowDirty?: boolean } = {},
): ReclaimResult {
  const path = existsSync(requestedPath) ? realpathSync(requestedPath) : resolve(requestedPath)
  return proveWorktree(path, options.clock ?? Date.now(), options.allowDirty).result
}

/** Reclaim one worktree only after its run rows and git state prove it reconstructible. */
export function reclaimWorktree(
  requestedPath: string,
  options: { dryRun?: boolean; clock?: number; allowDirty?: boolean } = {},
): ReclaimResult {
  const path = existsSync(requestedPath) ? realpathSync(requestedPath) : resolve(requestedPath)
  const preview = proveWorktree(path, options.clock ?? Date.now(), options.allowDirty)
  if (!preview.result.ok) return preview.result
  const previewOwner = preview.rows?.[0]
  const previewClaim = previewOwner ? fullClaimRefusal(path, previewOwner.id) : null
  if (previewClaim) return previewClaim
  if (options.dryRun) return preview.result
  const project = preview.project!
  const owner = { session: sessionId(), what: `reclaim worktree ${path}` }
  return withWorktreeLease(
    project.path,
    path,
    owner,
    () =>
      withCleanupLock(
        project.path,
        owner,
        () => {
          const proof = proveWorktree(path, options.clock ?? Date.now(), options.allowDirty)
          if (!proof.result.ok) return proof.result
          const lockedRows = proof.rows ?? []
          const lockedRow = lockedRows[0]
          const lockedClaim = lockedRow ? fullClaimRefusal(path, lockedRow.id) : null
          if (lockedClaim) return lockedClaim

          writableDb()
          const headRef = existsSync(path)
            ? git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
            : { ok: false, out: '' }
          const headBranch = headRef.ok ? headRef.out : ''
          const minted = lockedRow ? (lockedRow.minted_branch ?? '') : headBranch
          const keepBranch = lockedRows.length > 0
          const branchBefore = minted ? branchTip(project.path, minted) : null
          const removed = removeFor(
            {
              path,
              branch: minted,
              mintedBranch: lockedRow ? lockedRow.minted_branch : minted || null,
              base: lockedRow?.base_commit ?? '',
              repoRoot: project.path,
              source: lockedRow?.worktree_source ?? markedWorktreeSource(path) ?? undefined,
            },
            project.path,
            false,
            keepBranch,
            lockedRow?.id,
          )
          if (!removed.removed) return refuse(removed.detail)
          if (lockedRow) {
            const sharersAfter = fullClaimRefusal(path, lockedRow.id)
            if (sharersAfter) return sharersAfter
          }
          if (keepBranch && minted && branchBefore) {
            const branchAfter = branchTip(project.path, minted)
            if (branchAfter === null) {
              const restored = restoreBranch(project.path, minted, branchBefore)
              if (!restored.ok) {
                return refuse(
                  `project remove tool deleted branch ${minted}, and restoring ${branchBefore} failed: ${restored.error}`,
                )
              }
            } else if (branchAfter !== branchBefore) {
              return refuse(
                `project remove tool moved unique branch ${minted} from ${branchBefore} to ${branchAfter}; it was left at ${branchAfter}`,
              )
            }
          }
          if (lockedRows.length) {
            const clear = db().query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
            writeTransaction(() => {
              lockedRows.forEach((record) => {
                clear.run(minted || null, branchBefore, record.id)
                settleClaims(db(), {
                  rootRunId: record.root_id,
                  kind: 'worktree',
                  state: 'released',
                  settledAt: new Date().toISOString(),
                  detail: removed.detail,
                  allocationKey: path,
                })
                if (keepBranch && minted && branchBefore) {
                  settleClaims(db(), {
                    rootRunId: record.root_id,
                    kind: 'branch',
                    state: 'retained',
                    settledAt: new Date().toISOString(),
                    detail: `branch retained at ${branchBefore}`,
                    allocationKey: `refs/heads/${minted}`,
                  })
                }
              })
            })
          }
          const kept =
            keepBranch && minted && branchBefore
              ? `; kept branch ${minted}`
              : !keepBranch && minted && branchTip(project.path, minted)
                ? `; kept unique branch ${minted}`
                : ''
          return {
            ok: true,
            action: `reclaimed worktree ${path}; ${removed.detail}` + kept,
          }
        },
        5 * 60_000,
      ),
    5 * 60_000,
  )
}

/** Reclaim one local branch only when its commits remain reachable or its exact kept tip is recorded. */
export function reclaimBranch(
  subject: string,
  options: { dryRun?: boolean; clock?: number } = {},
): ReclaimResult {
  const colon = subject.indexOf(':')
  if (colon < 1 || colon === subject.length - 1) {
    return refuse(`branch subject must be <project>:<branch>; received ${subject}`)
  }
  const projectName = subject.slice(0, colon)
  const branch = subject.slice(colon + 1)
  const project = projectByName(projectName)
  if (!project) return refuse(`project ${projectName} is not registered`)
  const trunk =
    typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
      ? project.settings.trunk
      : null
  if (trunk === branch) {
    return refuse(`branch ${projectName}:${branch} is the registered landing branch`)
  }
  const production =
    typeof project.settings.productionBranch === 'string'
      ? project.settings.productionBranch.trim()
      : ''
  if (production === branch) {
    return refuse(`branch ${projectName}:${branch} is the registered production branch`)
  }
  const prove = (): { result: ReclaimResult; tip?: string } => {
    const rows = branchRows(projectName, branch)
    if (!rows.length)
      return {
        result: refuse(`no run row records minted branch ${projectName}:${branch}`),
      }
    const owners = proveRunOwners(rows)
    if (owners) return { result: owners }
    const tip = branchTip(project.path, branch)
    if (!tip)
      return {
        result: refuse(`branch ${projectName}:${branch} does not exist`),
      }
    const worktrees = git(project.path, ['worktree', 'list', '--porcelain'])
    if (!worktrees.ok) {
      return {
        result: refuse(
          `checked-out worktrees could not be inspected: ${worktrees.out || 'unknown error'}`,
        ),
      }
    }
    const checkedOut = worktrees.out
      .split('\n')
      .some((line) => line === `branch refs/heads/${branch}`)
    if (checkedOut)
      return {
        result: refuse(`branch ${projectName}:${branch} is checked out in a worktree`),
      }
    if (!trunk)
      return {
        result: refuse(`project ${projectName} records no landing branch`),
      }
    const absent = absentCommits(project.path, branch, trunk)
    if (absent === null)
      return {
        result: refuse(`reachability from landing branch ${trunk} could not be inspected`),
      }
    const classification = absent.length
      ? classifyMintedBranch(projectName, branch)
      : { state: 'empty' as const }
    const evidence = decideBranchReclaimEvidence({
      absentCommits: absent,
      classification: classification.state,
    })
    if (!evidence.allowed) {
      return {
        result: refuse(
          `branch classification is ${evidence.state}; commits unreachable from landing branch ${trunk}: ${absent.join(', ')}; ` +
            `prove a landing with orch branches landed ${branch} --pr <number>, or delete it by hand with git branch -D ${branch}`,
        ),
      }
    }
    const proof =
      evidence.proof === 'reachable'
        ? `every commit is reachable from ${trunk}`
        : `prune classifier marks the branch ${evidence.proof}`
    return {
      result: {
        ok: true,
        action: `would reclaim branch ${projectName}:${branch}; ${proof}`,
      },
      tip,
    }
  }
  const preview = prove()
  if (!preview.result.ok || options.dryRun) return preview.result
  const owner = {
    session: sessionId(),
    what: `reclaim branch ${projectName}:${branch}`,
  }
  return withWorktreeCreateLock(
    project.path,
    () =>
      withCleanupLock(
        project.path,
        owner,
        () => {
          const lockedProof = prove()
          if (!lockedProof.result.ok) return lockedProof.result
          const tip = lockedProof.tip!

          writableDb()
          const deleted = git(project.path, ['update-ref', '-d', `refs/heads/${branch}`, tip])
          if (!deleted.ok || branchTip(project.path, branch) !== null) {
            return refuse(
              `git did not delete branch ${projectName}:${branch} at proved tip ${tip}: ${deleted.out || 'ref moved'}`,
            )
          }
          settleDeletedBranch(projectName, branch)
          return {
            ok: true,
            action: `reclaimed branch ${projectName}:${branch}`,
          }
        },
        5 * 60_000,
      ),
    5 * 60_000,
  )
}
