// concern: pull-request merge
/**
 * Resolves forge and local proof facts, then performs an admitted merge.
 * The landing branch can still move between its fetch and the merge because the forge cannot condition a merge on the base tip without branch protection.
 */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writableDb } from '../database/db.ts'
import { passingGateForCommit } from '../gate/gate-passed.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt } from '../project/projects.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import {
  decideMergeAdmission,
  decideMergeProof,
  decidePullRequestIdentity,
  type MergeDecision,
  type MergeProofInput,
  type PullRequestCheck,
} from './merge-decision.ts'
import {
  interpretMergeQueue,
  MERGE_QUEUE_WAIT_MS,
  type MergeQueueObservation,
  type MergeQueueWaitState,
  mergeQueueEnqueueFailureRemedy,
  stepMergeQueueWait,
} from './merge-queue-decision.ts'
import { enqueuePullRequest, githubMergeQueueState } from './merge-queue-forge.ts'
import {
  admissionDecision,
  type PullRequestChange,
  recordMergeAdmission,
  resolvePullRequestChange,
  triageRefusal,
} from './pr-admission.ts'

export type PullRequestMergeFacts = {
  nodeId: string
  number: number
  headCommit: string
  headBranch: string
  baseBranch: string
  title: string
  state: string
}

export type PullRequestMergeAdapter = {
  view(cwd: string, target: string): PullRequestMergeFacts
  checks(cwd: string, number: number): PullRequestCheck[]
  landingState(
    cwd: string,
    headCommit: string,
    landingBranch: string,
  ): { remoteLandingTip: string; mergeBase: string }
  hasCommit(cwd: string, headCommit: string): boolean
  admission(
    cwd: string,
    headCommit: string,
    headBranch: string,
    database: Database,
  ): { change: PullRequestChange; decision: AdmissionDecision }
  recordAdmission(
    change: PullRequestChange,
    decision: AdmissionDecision,
    prNumber: number,
    database: Database,
  ): number | null
  merge(
    cwd: string,
    number: number,
    method: 'squash' | 'merge' | 'rebase',
    subject: string,
    headCommit: string,
  ): string
  queueState(cwd: string, nodeId: string): MergeQueueObservation
  enqueue(cwd: string, number: number, headCommit: string): void
  now(): number
  wait(milliseconds: number): void
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

function run(cwd: string, argv: string[]): ProcessResult {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function successful(cwd: string, argv: string[], label: string): string {
  const result = run(cwd, argv)
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

function parsed<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch (cause) {
    throw new Error(
      `${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

const cliPullRequestMergeAdapter: PullRequestMergeAdapter = {
  view(cwd, target) {
    const value = parsed<{
      id?: unknown
      number?: unknown
      headRefOid?: unknown
      headRefName?: unknown
      baseRefName?: unknown
      title?: unknown
      state?: unknown
    }>(
      successful(
        cwd,
        [
          'gh',
          'pr',
          'view',
          target,
          '--json',
          'id,number,headRefOid,headRefName,baseRefName,title,state',
        ],
        'pull-request lookup',
      ),
      'pull-request lookup',
    )
    if (
      typeof value.id !== 'string' ||
      !Number.isSafeInteger(value.number) ||
      typeof value.headRefOid !== 'string' ||
      typeof value.headRefName !== 'string' ||
      typeof value.baseRefName !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.state !== 'string'
    ) {
      throw new Error('pull-request lookup returned an unexpected JSON shape')
    }
    return {
      nodeId: value.id,
      number: Number(value.number),
      headCommit: value.headRefOid,
      headBranch: value.headRefName,
      baseBranch: value.baseRefName,
      title: value.title,
      state: value.state,
    }
  },
  checks(cwd, number) {
    const result = run(cwd, [
      'gh',
      'pr',
      'checks',
      String(number),
      '--json',
      'name,bucket,state,link',
    ])
    if (![0, 1, 8].includes(result.exitCode)) {
      throw new Error(
        `pull-request check lookup failed: ${result.stderr || `exit ${result.exitCode}`}`,
      )
    }
    const values = parsed<unknown>(result.stdout, 'pull-request check lookup')
    if (!Array.isArray(values)) {
      throw new Error('pull-request check lookup returned an unexpected JSON shape')
    }
    return values.map((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof value.name !== 'string' ||
        !['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(String(value.bucket)) ||
        typeof value.state !== 'string' ||
        typeof value.link !== 'string'
      ) {
        throw new Error('pull-request check lookup returned an unexpected JSON shape')
      }
      return value as PullRequestCheck
    })
  },
  landingState(cwd, headCommit, landingBranch) {
    successful(cwd, ['git', 'fetch', 'origin', landingBranch], 'remote landing-branch fetch')
    const remote = `refs/remotes/origin/${landingBranch}`
    return {
      remoteLandingTip: successful(
        cwd,
        ['git', 'rev-parse', '--verify', `${remote}^{commit}`],
        'remote landing-branch lookup',
      ),
      mergeBase: successful(
        cwd,
        ['git', 'merge-base', headCommit, remote],
        'landing merge-base lookup',
      ),
    }
  },
  hasCommit(cwd, headCommit) {
    return run(cwd, ['git', 'cat-file', '-e', `${headCommit}^{commit}`]).exitCode === 0
  },
  admission(cwd, headCommit, headBranch, database) {
    const change = resolvePullRequestChange(cwd, headCommit, database, undefined, headBranch)
    return { change, decision: admissionDecision(change, database) }
  },
  recordAdmission(change, decision, prNumber, database) {
    return recordMergeAdmission(change, decision, prNumber, database)
  },
  merge(cwd, number, method, subject, headCommit) {
    successful(
      cwd,
      [
        'gh',
        'pr',
        'merge',
        String(number),
        `--${method}`,
        '--subject',
        subject,
        '--match-head-commit',
        headCommit,
      ],
      'pull-request merge',
    )
    const value = parsed<{ mergeCommit?: { oid?: unknown } | null }>(
      successful(
        cwd,
        ['gh', 'pr', 'view', String(number), '--json', 'mergeCommit'],
        'merge-commit lookup',
      ),
      'merge-commit lookup',
    )
    if (typeof value.mergeCommit?.oid !== 'string') {
      throw new Error('merge-commit lookup returned no merge commit')
    }
    return value.mergeCommit.oid
  },
  queueState(cwd, nodeId) {
    return githubMergeQueueState(cwd, nodeId)
  },
  enqueue(cwd, number, headCommit) {
    enqueuePullRequest(cwd, number, headCommit)
  },
  now: Date.now,
  wait(milliseconds) {
    Bun.sleepSync(milliseconds)
  },
}

function collectMergeProof(
  pullRequest: PullRequestMergeFacts,
  landingBranch: string,
  requiredChecks: readonly string[],
  mergeQueue: boolean,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  database: Database,
): MergeProofInput {
  if (requiredChecks.length > 0) {
    const checks = adapter.checks(cwd, pullRequest.number)
    const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
    return {
      kind: 'required-checks',
      number: pullRequest.number,
      headCommit: pullRequest.headCommit,
      currentHeadCommit,
      requiredChecks,
      checks,
    }
  }
  const passingGateId = passingGateForCommit(pullRequest.headCommit, cwd, database).gateId
  if (passingGateId === null) {
    const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
    return {
      kind: 'local-gate',
      number: pullRequest.number,
      headCommit: pullRequest.headCommit,
      currentHeadCommit,
      landingBranch,
      mergeQueue,
      gate: { recorded: false },
    }
  }
  const landingState = mergeQueue
    ? { remoteLandingTip: '', mergeBase: '' }
    : adapter.landingState(cwd, pullRequest.headCommit, landingBranch)
  const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
  return {
    kind: 'local-gate',
    number: pullRequest.number,
    headCommit: pullRequest.headCommit,
    currentHeadCommit,
    landingBranch,
    mergeQueue,
    gate: {
      recorded: true,
      ...landingState,
    },
  }
}

function waitForQueuedMerge(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
): string {
  const deadline = adapter.now() + MERGE_QUEUE_WAIT_MS
  let waitState: MergeQueueWaitState = {
    enqueueSubmitted: false,
    activeEntryObserved: false,
    dequeueObservedAt: null,
  }
  while (true) {
    const state = interpretMergeQueue(adapter.queueState(cwd, pullRequest.nodeId))
    const now = adapter.now()
    const step = stepMergeQueueWait(pullRequest.number, waitState, state, now, deadline)
    waitState = step.state
    const action = step.action
    if (action.action === 'complete') return action.mergeCommit
    if (action.action === 'refuse') {
      throw new Error(`refusing merge: ${action.refusal}; cleared by: ${action.remedy}`)
    }
    if (action.action === 'enqueue') {
      enqueueForMergeQueue(pullRequest, cwd, adapter)
      continue
    }
    adapter.wait(action.delay)
  }
}

function enqueueForMergeQueue(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
): void {
  try {
    adapter.enqueue(cwd, pullRequest.number, pullRequest.headCommit)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `refusing merge: pull request #${pullRequest.number} could not be added to the merge queue: ${message}; cleared by: ${mergeQueueEnqueueFailureRemedy(pullRequest.number, message)}`,
    )
  }
}

type CheckedMergeAdmission = ReturnType<PullRequestMergeAdapter['admission']>

function collectMergeAdmission(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  database: Database,
): { decision: MergeDecision; checked: CheckedMergeAdmission | null } {
  if (!adapter.hasCommit(cwd, pullRequest.headCommit)) {
    return {
      checked: null,
      decision: decideMergeAdmission({
        checked: false,
        number: pullRequest.number,
        headCommit: pullRequest.headCommit,
        problem: `commit ${pullRequest.headCommit} is absent from the checkout`,
      }),
    }
  }
  const checked = adapter.admission(cwd, pullRequest.headCommit, pullRequest.headBranch, database)
  if (checked.decision.complete) {
    return {
      checked,
      decision: decideMergeAdmission({
        checked: true,
        number: pullRequest.number,
        complete: true,
      }),
    }
  }
  const triage = checked.decision.triage
  if (triage.complete) throw new Error('incomplete admission returned complete review triage')
  return {
    checked,
    decision: decideMergeAdmission({
      checked: true,
      number: pullRequest.number,
      complete: false,
      triageRefusal: triageRefusal(checked.change, triage),
    }),
  }
}

export function mergePullRequest(
  target: string,
  cwd = process.cwd(),
  adapter: PullRequestMergeAdapter = cliPullRequestMergeAdapter,
  database: Database = writableDb(),
): string {
  const project = projectAt(cwd, database)
  if (!project) {
    throw new Error(
      `cannot resolve a project for ${cwd}; run ${PLATFORM_SLUG} pr merge from a registered checkout`,
    )
  }
  const landingBranch = project.settings.trunk?.trim()
  const release = project.settings.release
  if (!landingBranch || !release) {
    throw new Error(
      `project ${project.name} has no landing branch and release policy; cleared by: ${PLATFORM_SLUG} project set ${project.name} --settings '<settings with trunk and release>'`,
    )
  }

  try {
    const pullRequest = adapter.view(cwd, target)
    const identityDecision = decidePullRequestIdentity({
      number: pullRequest.number,
      state: pullRequest.state,
      baseBranch: pullRequest.baseBranch,
      landingBranch,
    })
    if (!identityDecision.admitted) {
      throw new Error(`refusing merge: ${identityDecision.refusal}`)
    }
    const admission = collectMergeAdmission(pullRequest, cwd, adapter, database)
    if (!admission.decision.admitted) {
      throw new Error(`refusing merge: ${admission.decision.refusal}`)
    }
    const input = collectMergeProof(
      pullRequest,
      landingBranch,
      release.requiredChecks,
      release.mergeQueue ?? false,
      cwd,
      adapter,
      database,
    )
    const decision = decideMergeProof(input)
    if (!decision.admitted) throw new Error(`refusing merge: ${decision.refusal}`)
    adapter.recordAdmission(
      admission.checked!.change,
      admission.checked!.decision,
      pullRequest.number,
      database,
    )
    if (release.mergeQueue) {
      return waitForQueuedMerge(pullRequest, cwd, adapter)
    }
    const subject = `${pullRequest.title} (#${pullRequest.number})`
    return adapter.merge(
      cwd,
      pullRequest.number,
      release.mergeMethod,
      subject,
      pullRequest.headCommit,
    )
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (message.startsWith('refusing merge:')) throw cause
    throw new Error(
      `refusing merge because the pull request proof was not checked: ${message}; cleared by: restore forge and repository access, then ${PLATFORM_SLUG} pr merge ${target}`,
    )
  }
}
