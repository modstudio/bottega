// concern: chain tree service
/** Gathers chain-owned worktree facts and safely prepares the selected tree for attachment. */

import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { realpathOrSpelled, withoutTrailingSeparators } from '../git/checkout-identity.ts'
import { branchOf, git, gitContext, gitOk, worktreeListPorcelain } from '../git/git-environment.ts'
import { withWorktreeCreateLock, withWorktreeLease } from '../project/project-lock.ts'
import { type Project, resolvedWorktreeTool } from '../project/projects.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { dirtyChainTreePath, refuseMissingChainTreeDatabase } from './chain-database-guard.ts'
import {
  type ChainTreeAttachDecision,
  type ChainTreeCandidate,
  type ChainTreeRelation,
  decideChainTreeAttach,
} from './chain-tree-attach.ts'
import { liveRunOnTree, renderChainTreeAttachRefusal } from './held-branch-remedy.ts'
import {
  continuationBranchAvailability,
  continuationBranchPlan,
  parseWorktreeList,
  type ResumeTreePlan,
  resumeTreePlan,
} from './resume-tree.ts'

type ChainTreeRow = {
  record_id: string
  worktree: string
  base_commit: string | null
  worktree_source: Worktree['source'] | null
}

export type PreparedChainTree = {
  worktree: Worktree
  ownerRunId: string
}

function canonicalPath(path: string): string {
  return withoutTrailingSeparators(realpathOrSpelled(path))
}

function commitList(cwd: string, range: string): string[] {
  const output = git(['log', '--format=%h %s', range, '--'], cwd)
  return output ? output.split('\n') : []
}

function relationToTip(cwd: string, head: string, tip: string | null): ChainTreeRelation {
  if (!tip || head === tip) return 'equal'
  if (gitOk(['merge-base', '--is-ancestor', tip, head], cwd) !== null) return 'head-ahead'
  if (gitOk(['merge-base', '--is-ancestor', head, tip], cwd) !== null) return 'tip-ahead'
  return 'diverged'
}

function candidateFacts(row: ChainTreeRow, branchTip: string | null): ChainTreeCandidate {
  const exists = existsSync(row.worktree)
  if (!exists) {
    return {
      path: row.worktree,
      ownerRunId: row.record_id,
      exists: false,
      checkedOutBranch: null,
      head: '',
      clean: false,
      liveRunId: null,
      relation: 'equal',
      headOnly: [],
      tipOnly: [],
    }
  }
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], row.worktree)
  const relation = relationToTip(row.worktree, head, branchTip)
  return {
    path: row.worktree,
    ownerRunId: row.record_id,
    exists: true,
    checkedOutBranch: branchOf(row.worktree),
    head,
    clean: git(['status', '--porcelain', '--untracked-files=all'], row.worktree) === '',
    liveRunId: liveRunOnTree(row.worktree),
    relation,
    headOnly:
      branchTip && (relation === 'head-ahead' || relation === 'diverged')
        ? commitList(row.worktree, `${branchTip}..${head}`)
        : [],
    tipOnly:
      branchTip && (relation === 'tip-ahead' || relation === 'diverged')
        ? commitList(row.worktree, `${head}..${branchTip}`)
        : [],
  }
}

function chainTreeRows(rootId: string): ChainTreeRow[] {
  const rows = db()
    .query(
      `SELECT record_id,worktree,base_commit,worktree_source
         FROM run
        WHERE (record_id=? OR parent_run_record_id=?)
          AND agent <> '(pending)' AND worktree IS NOT NULL
        ORDER BY turn DESC,number DESC`,
    )
    .all(rootId, rootId) as ChainTreeRow[]
  const seen = new Set<string>()
  return rows.filter((row) => {
    const path = canonicalPath(row.worktree)
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
}

/** Canonical paths recorded by any turn in the chain, including paths now missing from disk. */
export function chainTreePaths(rootId: string): string[] {
  return chainTreeRows(rootId).map((row) => canonicalPath(row.worktree))
}

function gatherChainTreeDecision(input: {
  rootId: string
  projectPath: string
  branch: string
  branchTip: string | null
}): { decision: ChainTreeAttachDecision; rows: ChainTreeRow[] } {
  const rows = chainTreeRows(input.rootId)
  const candidates = rows.map((row) => candidateFacts(row, input.branchTip))
  const chainPaths = new Set(candidates.map((candidate) => canonicalPath(candidate.path)))
  const availability = continuationBranchAvailability(
    input.branch,
    null,
    parseWorktreeList(worktreeListPorcelain(input.projectPath)).map((tree) => ({
      ...tree,
      path: canonicalPath(tree.path),
    })),
    [...chainPaths],
  )
  return {
    decision: decideChainTreeAttach({
      branch: input.branch,
      branchTip: input.branchTip,
      candidates,
      branchHolderOutsideChain: availability.action === 'refuse' ? availability.holdingPath : null,
    }),
    rows,
  }
}

function requireAttachDecision(input: {
  rootId: string
  projectPath: string
  branch: string
  branchTip: string | null
  retryCommand: string
}): ReturnType<typeof gatherChainTreeDecision> {
  const gathered = gatherChainTreeDecision(input)
  if (gathered.decision.action === 'refuse') {
    throw new Error(
      renderChainTreeAttachRefusal({
        path: gathered.decision.path,
        branch: input.branch,
        remedy: gathered.decision.remedy,
        retryCommand: input.retryCommand,
      }),
    )
  }
  return gathered
}

/** Select, lock, revalidate, and when needed switch a chain-owned tree onto its branch. */
export function prepareChainTreeAttachment(input: {
  rootId: string
  projectPath: string
  branch: string
  branchTip: string | null
  retryCommand: string
  base?: string
}): PreparedChainTree | null {
  const initial = requireAttachDecision(input)
  if (initial.decision.action === 'none') return null
  const selectedPath = initial.decision.path
  return withWorktreeLease(
    input.projectPath,
    selectedPath,
    { session: sessionId(), what: `attach chain tree for ${input.rootId}` },
    () =>
      withWorktreeCreateLock(input.projectPath, () => {
        const current = requireAttachDecision(input)
        const decision = current.decision
        if (decision.action !== 'attach' || decision.path !== selectedPath) {
          throw new Error(
            `run ${input.rootId} chain tree selection changed while attachment waited; ` +
              `then retry ${input.retryCommand}`,
          )
        }
        if (decision.switchToBranch) git(['switch', input.branch], selectedPath)
        const branch = branchOf(selectedPath)
        const head = gitContext(selectedPath, 'rev-parse', '--verify', 'HEAD^{commit}')
        if (branch !== input.branch || head !== input.branchTip) {
          throw new Error(
            `run ${input.rootId} cannot attach ${selectedPath}: expected ${input.branch} at ` +
              `${input.branchTip}, found ${branch ?? 'detached HEAD'} at ${head ?? 'unknown'}; ` +
              `then retry ${input.retryCommand}`,
          )
        }
        const owner = current.rows.find((row) => row.record_id === decision.ownerRunId)!
        return {
          ownerRunId: owner.record_id,
          worktree: {
            path: selectedPath,
            branch: input.branch,
            base: input.base ?? owner.base_commit ?? input.branchTip!,
            repoRoot: input.projectPath,
            source: owner.worktree_source ?? undefined,
          },
        }
      }),
  )
}

/** Resolve the continuation branch, attach a chain tree when possible, and otherwise plan recovery. */
export function continuationChainTree(input: {
  rootId: string
  rootBranch: string | null
  rootBranchTip: string | null
  latest: {
    record_id: string
    branch: string | null
  }
  project: Project | null
  writesRepo: boolean
}): {
  project: Project | null
  recordedTreeMatches: boolean
  plan: ResumeTreePlan | null
  branchSource: ReturnType<typeof continuationBranchPlan>['source']
  attachedTree: PreparedChainTree | null
  candidatePaths: string[]
} {
  const latestBranchTip =
    input.latest.branch && input.project
      ? gitContext(
          input.project.path,
          'rev-parse',
          '--verify',
          `refs/heads/${input.latest.branch}^{commit}`,
        )
      : null
  const branchPlan = continuationBranchPlan({
    latestBranch: input.latest.branch,
    latestBranchTip,
    rootBranch: input.rootBranch,
  })
  const branch = branchPlan.branch
  const branchTip =
    branchPlan.tip ??
    (branch && input.project
      ? gitContext(input.project.path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
      : null)
  const attachedTree =
    input.writesRepo && branch && input.project
      ? prepareChainTreeAttachment({
          rootId: input.rootId,
          projectPath: input.project.path,
          branch,
          branchTip,
          retryCommand: `${PLATFORM_SLUG} run continue ${input.rootId}`,
        })
      : null
  const worktreeTool = input.project ? resolvedWorktreeTool(input.project) : null
  const plan =
    branch && input.project
      ? resumeTreePlan({
          rootId: input.rootId,
          branch,
          recordedTreeMatches: Boolean(attachedTree),
          hasCreate: Boolean(
            worktreeTool?.create || worktreeTool?.recipe || worktreeTool?.recipePath,
          ),
          branchTip,
          retainedTip: gitContext(
            input.project.path,
            'rev-parse',
            '--verify',
            `refs/orch/retained/${input.rootId}^{commit}`,
          ),
          recordedTip: input.rootBranchTip,
        })
      : null
  if (plan?.action === 'refuse') {
    throw new Error(
      `run ${input.rootId} cannot recreate its continuation tree for branch ${branch}: ` +
        'no retained tip exists',
    )
  }
  if (
    input.writesRepo &&
    !attachedTree &&
    (plan?.action === 'recreate-on-branch' || plan?.action === 'recreate-then-restore')
  ) {
    refuseMissingChainTreeDatabase(input.rootId, {
      dirtyTreePath: dirtyChainTreePath(input.rootId),
      retryCommand: `${PLATFORM_SLUG} run continue ${input.rootId}`,
    })
  }
  return {
    project: input.project,
    recordedTreeMatches: Boolean(attachedTree),
    plan,
    branchSource: branchPlan.source,
    attachedTree,
    candidatePaths: chainTreePaths(input.rootId),
  }
}
