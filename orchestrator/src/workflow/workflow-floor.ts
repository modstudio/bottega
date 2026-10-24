// concern: workflows
/** Pure floor-satisfaction for a workflow step. Must not know stores, processes, or clocks. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  commandExitBindingRefusal,
  commandExitMismatchRefusal,
  floorsAcceptPullRequestLink,
  gateFloorRefusal,
} from './workflow-floor-refusal.ts'

type TrackerStateCategory = 'backlog' | 'open' | 'active' | 'review' | 'done' | 'dropped'
type TrackerStates = Record<string, TrackerStateCategory>
const hasRecordIdShape = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export const floorKinds = [
  'ruling',
  'command-exit',
  'recorded-artifact',
  'tracker-transition',
] as const
export type FloorKind = (typeof floorKinds)[number]
export type EnforcementMode = 'note-only' | 'floors'
export type CommandEvidence = 'gate' | 'pull-request'

export const floorGuidance = {
  ruling: `call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\`; where you rule the step yourself, pass \`self_ruling\` with \`self_ruling_basis\` (or \`--self-ruling <text>\` with \`--basis <text>\`) on the closing call`,
  'command-exit': `run it with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass \`--artifact exec:<id>\``,
  'recorded-artifact':
    'record or attach the artifact and pass `--artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<UUID> | GitHub pull-request link>`',
  'tracker-transition': 'make the tracker transition and pass `--task <KEY>`',
} satisfies Record<FloorKind, string>

export function evidenceGuidance(kind: FloorKind, operatorRuling: boolean): string {
  if (kind === 'ruling' && operatorRuling)
    return `call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\``
  return floorGuidance[kind]
}

export const DEFAULT_EXPECTED_EXIT_CODE = 0
export const DEFAULT_EXPECTED_STATUS = 'done'

export function isFloorKind(value: string): value is FloorKind {
  for (const kind of floorKinds) if (kind === value) return true
  return false
}

export type Floor = {
  kind: FloorKind
  deferrable: boolean
  expectedExitCode: number
  expectedStatus: string
  requirePullRequest: boolean
  operatorRuling: boolean
  commandEvidence?: CommandEvidence
}

export type ArtifactRef =
  | { kind: 'task'; key: string }
  | { kind: 'comment'; key: string; id: string }
  | { kind: 'probe'; recordId: string }
  | { kind: 'exec'; recordId: string }
  | { kind: 'doc'; address: string }
  | { kind: 'run'; id: string }
  | { kind: 'attached-text'; id: string }
  | { kind: 'pull-request'; url: string }
  | { kind: 'id'; id: number }

type ValidatedSatisfy =
  | { id: string; found: false }
  | {
      id: string
      found: true
      open: boolean
      abandoned: boolean
      cursorMatches: boolean
      floor: Floor
    }

export type ValidatedEvidence = {
  runOffered?: string | number
  artifactRunOffered?: string
  ruling?: {
    id: number
    answered: boolean
    answeredByOperator: boolean
    boundToCursor: boolean
    boundToStep: boolean
    answeredAt?: string | null
  }
  review?: {
    recordId: string
    number: number
    allFindingsDisposed: boolean
    allLensesGraded: boolean
    unfinishedReviewIds?: number[]
  }
  gate?: {
    recordId: string
    finished: boolean
    exitCode: number | null
    project: string | null
    commit: string | null
  }
  run?: { id: string; terminal: boolean; exitCode: number | null }
  probe?: { id: number; exitCode: number }
  exec?: {
    id: number
    recordId: string
    command: string
    argv: string[] | null
    commandIdentity?: BottegaCommandIdentity
    exitCode: number
    sessionMatches: boolean
    sessionAdoptedCursor: boolean
    createdAfterStepActivation: boolean
    checkoutBranch: string | null
    headCommit: string | null
    cursorBranch: string | null
    output: string
    outputWithheld?: boolean
    commandWithheld?: boolean
    pullRequestCondition?: string
  }
  artifact?: { ref: string; exists: boolean }
  pullRequest?: {
    url: string
    repository: string | null
    projectRepository: string | null
    state: string
    head: string
    base: string
    cursorBranch: string
    trunk: string
  }
  task?: {
    key: string
    status: string | null
    statusCategory: string | null
    mergedPullRequest: boolean
    trackerStates: TrackerStates
  }
  deferReason?: string
  satisfy?: ValidatedSatisfy
  tree?: { project: string; worktree?: string | null; commit: string | null }
}

export type OpenObligation = {
  id: string
  stepOrdinal: number
  stepSlug: string
  floor: FloorKind
}

type EvidenceRef = { flag: string; value: string }

export type FloorDecision =
  | {
      action: 'allow'
      enforcement: EnforcementMode
      refs: EvidenceRef[]
      defer?: { floor: FloorKind; reason: string }
      satisfyId?: string
    }
  | { action: 'refuse'; message: string }

export type FloorSatisfactionInput = {
  floors: Floor[]
  evidence: ValidatedEvidence
  enforcement: EnforcementMode
  finishing: boolean
  openObligations: OpenObligation[]
  freshRulingAfter?: string
}

export function flagForFloor(kind: FloorKind): string {
  if (kind === 'ruling') return '--ruling <question id> or --review <review id>'
  if (kind === 'command-exit')
    return '--gate <gate execution id> or --run <run id> or --artifact probe:<id> or --artifact exec:<id>'
  if (kind === 'recorded-artifact')
    return '--artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<UUID> | GitHub pull-request link>'
  if (kind === 'tracker-transition') return '--task <KEY>'
  throw new Error(`unknown floor kind "${String(kind)}"`)
}

export function parseArtifactRef(value: string): ArtifactRef | { error: string } {
  const trimmed = value.trim()
  const comment = /^task:([^#\s]+)#comment:(\S+)$/i.exec(trimmed)
  if (comment) return { kind: 'comment', key: comment[1]!.toUpperCase(), id: comment[2]! }
  const task = /^task:([^#\s]+)$/i.exec(trimmed)
  if (task) return { kind: 'task', key: task[1]!.toUpperCase() }
  const probe = /^probe:(\S+)$/i.exec(trimmed)
  if (probe && hasRecordIdShape(probe[1]!))
    return { kind: 'probe', recordId: probe[1]!.toLowerCase() }
  const exec = /^exec:(\S+)$/i.exec(trimmed)
  if (exec && hasRecordIdShape(exec[1]!)) return { kind: 'exec', recordId: exec[1]!.toLowerCase() }
  const doc = /^doc:(\S+)$/i.exec(trimmed)
  if (doc) return { kind: 'doc', address: doc[1]! }
  const run = /^run:(\S+)$/i.exec(trimmed)
  if (run) return { kind: 'run', id: run[1]! }
  const attachedText = /^attached-text:(.+)$/i.exec(trimmed)
  if (attachedText && hasRecordIdShape(attachedText[1]!))
    return { kind: 'attached-text', id: attachedText[1]!.toLowerCase() }
  if (githubPullRequestUrlIn(trimmed) === trimmed) return { kind: 'pull-request', url: trimmed }
  if (/^\d+$/.test(trimmed)) return { kind: 'id', id: Number(trimmed) }
  return {
    error: `--artifact ${trimmed} is not doc:<scope>/<subject-or-_>/<slug>, doc:<UUID>, task:<KEY>, task:<KEY>#comment:<id>, a run number, probe:<id>, exec:<id>, attached-text:<UUID>, or a GitHub pull-request link`,
  }
}

export function catalogueFloors(
  kinds: readonly string[],
  deferrable: readonly string[] = [],
  expectedStatus: string | readonly string[] = DEFAULT_EXPECTED_STATUS,
  requirePullRequest = false,
  operatorRuling = false,
  commandEvidence?: CommandEvidence,
): Floor[] {
  return kinds.flatMap((kind) => {
    if (!isFloorKind(kind)) throw new Error(`unknown floor kind "${kind}"`)
    const statuses =
      kind === 'tracker-transition' && Array.isArray(expectedStatus)
        ? expectedStatus
        : [
            Array.isArray(expectedStatus)
              ? (expectedStatus[0] ?? DEFAULT_EXPECTED_STATUS)
              : expectedStatus,
          ]
    return statuses.map((status) => ({
      kind,
      deferrable: deferrable.includes(kind),
      expectedExitCode: DEFAULT_EXPECTED_EXIT_CODE,
      expectedStatus: status,
      requirePullRequest: kind === 'tracker-transition' && requirePullRequest,
      operatorRuling: kind === 'ruling' && operatorRuling,
      ...(commandEvidence ? { commandEvidence } : {}),
    }))
  })
}

function catalogueFloorsFor(
  step: {
    floor: readonly string[]
    deferrable?: readonly string[]
    expectedExitCodes?: Readonly<Record<string, number>>
    expectedStatus?: string | readonly string[]
    requirePullRequest?: boolean
    operatorRuling?: boolean
    commandEvidence?: CommandEvidence
  },
  outcome?: string,
  kinds: readonly string[] = step.floor,
): Floor[] {
  const floors = catalogueFloors(
    kinds,
    step.deferrable,
    step.expectedStatus,
    step.requirePullRequest,
    step.operatorRuling,
    step.commandEvidence,
  )
  const expectedExitCode = outcome === undefined ? undefined : step.expectedExitCodes?.[outcome]
  return expectedExitCode === undefined
    ? floors
    : floors.map((floor) =>
        floor.kind === 'command-exit' ? { ...floor, expectedExitCode } : floor,
      )
}

type CloseFloorStep = Parameters<typeof catalogueFloorsFor>[0] & {
  rulingOutcomes?: readonly string[]
}

/** Floors that apply to a close: a ruling outcome (or a forced ruling) replaces the ordinary floor. */
export function decideCloseFloors(
  step: CloseFloorStep,
  outcome: string | undefined,
  forceRuling = false,
): Floor[] {
  if (forceRuling || (outcome !== undefined && step.rulingOutcomes?.includes(outcome)))
    return catalogueFloorsFor(step, outcome, ['ruling'])
  return catalogueFloorsFor(step, outcome)
}

/** Whether the effective floor for this close accepts a ruling made by the agent. */
export function mayCloseOnAgentSelfRuling(
  step: CloseFloorStep,
  outcome: string | undefined,
  forceRuling = false,
): boolean {
  return decideCloseFloors(step, outcome, forceRuling).some(
    (floor) => floor.kind === 'ruling' && !floor.operatorRuling,
  )
}

export function reentryBoundRefusal(
  reenterOutcome: string,
  outcomes: readonly string[] | undefined,
): string {
  const alternative = (outcomes ?? []).filter((item) => item !== reenterOutcome)
  const named = alternative.length ? ` (${alternative.join(', ')})` : ''
  return (
    `automatic re-entry bound is reached; call \`${PLATFORM_SLUG} workflow await\`, ` +
    `then \`${PLATFORM_SLUG} workflow rule\`, or close with a non-re-entering outcome${named}`
  )
}

export function allowedCloseFloor(
  floor: FloorDecision,
  requireRuling: boolean,
  step: { reenter?: { outcome: string }; outcomes?: string[] },
): Extract<FloorDecision, { action: 'allow' }> {
  if (floor.action === 'refuse')
    throw new Error(
      requireRuling
        ? reentryBoundRefusal(step.reenter?.outcome ?? '', step.outcomes)
        : floor.message,
    )
  return floor
}

function rulingMet(floor: Floor, evidence: ValidatedEvidence, freshRulingAfter?: string): boolean {
  const ruling = evidence.ruling
  const review = evidence.review
  const fresh =
    freshRulingAfter === undefined ||
    Boolean(ruling?.answeredAt && ruling.answeredAt > freshRulingAfter)
  const question = Boolean(
    ruling?.answered &&
      ruling.boundToCursor &&
      ruling.boundToStep &&
      (!floor.operatorRuling || ruling.answeredByOperator) &&
      fresh,
  )
  const triaged = Boolean(
    freshRulingAfter === undefined &&
      !floor.operatorRuling &&
      review?.allFindingsDisposed &&
      review.allLensesGraded,
  )
  return question || triaged
}

type PullRequestLinkFacts = {
  kind: 'link'
  repository: string | null
  projectRepository: string | null
  state: string
  head: string
  base: string
  cursorBranch: string
  trunk: string
}

export type PullRequestEvidenceFacts =
  | {
      kind: 'exec'
      argv: string[] | null
      commandIdentity?: BottegaCommandIdentity
      exitCode: number
      sessionBound: boolean
      createdAfterStepActivation: boolean
      checkoutBranch: string | null
      headCommit: string | null
      cursorBranch: string | null
      output: string
      outputWithheld: boolean
      commandWithheld?: boolean
      link?: PullRequestLinkFacts
      linkCondition?: string
    }
  | PullRequestLinkFacts

export type PullRequestEvidenceDecision = { met: true } | { met: false; condition: string }

const WITHHELD_PULL_REQUEST_OUTPUT = '[withheld: secret-shaped content]'
const WITHHELD_PULL_REQUEST_CONDITION =
  'the recorded output was withheld, so the pull-request URL cannot be read'
const WITHHELD_PULL_REQUEST_COMMAND_CONDITION = `the recorded command was withheld, so it cannot be identified as ${PLATFORM_SLUG} pr create`

function execOutputWithheld(facts: { outputWithheld: boolean; output: string }): boolean {
  return facts.outputWithheld || facts.output === WITHHELD_PULL_REQUEST_OUTPUT
}

export type BottegaCommandIdentity = {
  resolvedCandidate: string | null
  mainCheckoutExecutable: string | null
  installedExecutable: string | null
}

/** Matches one bottega verb after the adapter has resolved any path-shaped executable. */
export function bottegaVerbArgv(
  argv: string[] | null,
  verb: readonly string[],
  identity?: BottegaCommandIdentity,
): argv is string[] {
  if (argv === null) return false
  const executable = argv[0] ?? ''
  const registeredPath = Boolean(
    identity?.resolvedCandidate &&
      (identity.resolvedCandidate === identity.mainCheckoutExecutable ||
        identity.resolvedCandidate === identity.installedExecutable),
  )
  return (
    (executable === PLATFORM_SLUG || registeredPath) &&
    verb.every((part, index) => argv[index + 1] === part)
  )
}

export function pullRequestCreateArgv(
  argv: string[] | null,
  identity?: BottegaCommandIdentity,
): argv is string[] {
  return bottegaVerbArgv(argv, ['pr', 'create'], identity)
}

export function githubPullRequestUrlIn(output: string): string | undefined {
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?/i.exec(output)?.[0]
}

function decidePullRequestExec(
  facts: Extract<PullRequestEvidenceFacts, { kind: 'exec' }>,
): PullRequestEvidenceDecision {
  if (facts.argv === null && facts.commandWithheld)
    return { met: false, condition: WITHHELD_PULL_REQUEST_COMMAND_CONDITION }
  if (!pullRequestCreateArgv(facts.argv, facts.commandIdentity))
    return { met: false, condition: `the recorded command is not ${PLATFORM_SLUG} pr create` }
  if (facts.argv.includes('-h') || facts.argv.includes('--help'))
    return { met: false, condition: 'the recorded command is a help invocation' }
  if (facts.exitCode !== 0)
    return { met: false, condition: `the recorded command exited ${facts.exitCode}, not 0` }
  if (!facts.sessionBound)
    return { met: false, condition: 'the recorded command is not bound to this cursor session' }
  if (!facts.createdAfterStepActivation)
    return { met: false, condition: 'the recorded command predates this step activation' }
  if (!facts.cursorBranch) return { met: false, condition: 'this cursor has no branch' }
  if (facts.checkoutBranch !== facts.cursorBranch)
    return {
      met: false,
      condition: `the recorded command checkout branch is ${facts.checkoutBranch ?? 'unset'}, not this cursor's ${facts.cursorBranch}`,
    }
  if (!facts.headCommit) return { met: false, condition: 'the recorded command has no head commit' }
  if (execOutputWithheld(facts)) return { met: false, condition: WITHHELD_PULL_REQUEST_CONDITION }
  if (!githubPullRequestUrlIn(facts.output))
    return {
      met: false,
      condition: 'the recorded command output does not contain a GitHub pull-request URL',
    }
  if (!facts.link)
    return {
      met: false,
      condition:
        facts.linkCondition ?? 'the recorded command output pull-request URL could not be judged',
    }
  return decidePullRequestLink(facts.link)
}

function decidePullRequestLink(facts: PullRequestLinkFacts): PullRequestEvidenceDecision {
  if (!facts.projectRepository)
    return { met: false, condition: 'the project origin is not a GitHub repository' }
  if (facts.repository !== facts.projectRepository)
    return {
      met: false,
      condition: `the pull request repository is ${facts.repository ?? 'unset'}, not this project's ${facts.projectRepository}`,
    }
  if (facts.state !== 'OPEN' && facts.state !== 'MERGED')
    return {
      met: false,
      condition: `the pull request state is ${facts.state || 'unset'}, not open or merged`,
    }
  if (facts.head !== facts.cursorBranch)
    return {
      met: false,
      condition: `the pull request head is ${facts.head}, not this cursor's ${facts.cursorBranch}`,
    }
  if (facts.base !== facts.trunk)
    return {
      met: false,
      condition: `the pull request base is ${facts.base}, not this project's ${facts.trunk}`,
    }
  return { met: true }
}

/** Keeps every policy choice about evidence that proves a pull request in one pure decision. */
export function decidePullRequestEvidence(
  facts: PullRequestEvidenceFacts | undefined,
): PullRequestEvidenceDecision {
  if (!facts) return { met: false, condition: 'no pull-request evidence was supplied' }
  return facts.kind === 'exec' ? decidePullRequestExec(facts) : decidePullRequestLink(facts)
}

function execPullRequestFacts(
  evidence: ValidatedEvidence,
): Extract<PullRequestEvidenceFacts, { kind: 'exec' }> | undefined {
  const exec = evidence.exec
  if (!exec) return undefined
  return {
    kind: 'exec',
    argv: exec.argv,
    commandIdentity: exec.commandIdentity,
    exitCode: exec.exitCode,
    sessionBound: exec.sessionMatches || exec.sessionAdoptedCursor,
    createdAfterStepActivation: exec.createdAfterStepActivation,
    checkoutBranch: exec.checkoutBranch,
    headCommit: exec.headCommit,
    cursorBranch: exec.cursorBranch,
    output: exec.output,
    outputWithheld: exec.outputWithheld === true,
    commandWithheld: exec.commandWithheld === true,
    link: evidence.pullRequest ? { kind: 'link', ...evidence.pullRequest } : undefined,
    linkCondition: exec.pullRequestCondition,
  }
}

function linkPullRequestFacts(
  evidence: ValidatedEvidence,
): Extract<PullRequestEvidenceFacts, { kind: 'link' }> | undefined {
  return evidence.pullRequest ? { kind: 'link', ...evidence.pullRequest } : undefined
}

function pullRequestFacts(evidence: ValidatedEvidence): PullRequestEvidenceFacts | undefined {
  return execPullRequestFacts(evidence) ?? linkPullRequestFacts(evidence)
}

function commandExitMet(floor: Floor, evidence: ValidatedEvidence): boolean {
  const gate = evidence.gate
  const run = evidence.run
  const gateOk = Boolean(
    gate?.finished &&
      gate.exitCode === floor.expectedExitCode &&
      (!floor.commandEvidence ||
        (gate.project === evidence.tree?.project &&
          gate.commit !== null &&
          evidence.tree?.commit !== null &&
          gate.commit === evidence.tree?.commit)),
  )
  if (floor.commandEvidence === 'gate') return gateOk
  const runOk = Boolean(run?.terminal && run.exitCode === floor.expectedExitCode)
  const probeOk = evidence.probe?.exitCode === floor.expectedExitCode
  const execOk = Boolean(
    evidence.exec?.exitCode === floor.expectedExitCode &&
      (evidence.exec.sessionMatches || evidence.exec.sessionAdoptedCursor) &&
      evidence.exec.createdAfterStepActivation,
  )
  if (floor.commandEvidence === 'pull-request')
    return decidePullRequestEvidence(pullRequestFacts(evidence)).met
  return gateOk || runOk || probeOk || execOk
}

function normalizedTrackerWord(value: string): string {
  return value.toLowerCase().replace(/[ -]+/g, '_')
}

function expectedTrackerCategory(
  expectedStatus: string,
  states: TrackerStates,
): string | undefined {
  const mapped = states[expectedStatus] ?? states[normalizedTrackerWord(expectedStatus)]
  return mapped === 'backlog' ? 'open' : mapped
}

function categoryHasSeveralStates(category: string, states: TrackerStates): boolean {
  return (
    Object.values(states).filter((mapped) => (mapped === 'backlog' ? 'open' : mapped) === category)
      .length > 1
  )
}

function taskMet(floor: Floor, evidence: ValidatedEvidence): boolean {
  const task = evidence.task
  const expectedCategory = task
    ? expectedTrackerCategory(floor.expectedStatus, task.trackerStates)
    : undefined
  const requiresExactStatus = Boolean(
    expectedCategory && categoryHasSeveralStates(expectedCategory, task?.trackerStates ?? {}),
  )
  if (
    !task ||
    (task.status !== floor.expectedStatus && requiresExactStatus) ||
    (!requiresExactStatus &&
      task.status !== floor.expectedStatus &&
      task.statusCategory !== floor.expectedStatus &&
      task.statusCategory !== expectedCategory)
  )
    return false
  return !floor.requirePullRequest || task.mergedPullRequest
}

function floorIsMet(floor: Floor, evidence: ValidatedEvidence, freshRulingAfter?: string): boolean {
  if (floor.kind === 'ruling') return rulingMet(floor, evidence, freshRulingAfter)
  if (floor.kind === 'command-exit') return commandExitMet(floor, evidence)
  if (floor.kind === 'recorded-artifact')
    return floor.commandEvidence === 'pull-request'
      ? decidePullRequestEvidence(pullRequestFacts(evidence)).met
      : evidence.artifact?.exists === true
  if (floor.kind === 'tracker-transition') return taskMet(floor, evidence)
  throw new Error(`unknown floor kind "${String(floor.kind)}"`)
}

function trackerReadback(task: NonNullable<ValidatedEvidence['task']>): string {
  return `${task.key} reads back as ${task.status ?? 'unset'} (category ${task.statusCategory ?? 'unset'})`
}

function trackerUnmetMessage(floor: Floor, evidence: ValidatedEvidence): string {
  const pullRequest = floor.requirePullRequest ? ' with a merged pull request for the task key' : ''
  const expectedCategory = evidence.task
    ? expectedTrackerCategory(floor.expectedStatus, evidence.task.trackerStates)
    : undefined
  const expected = expectedCategory
    ? `${floor.expectedStatus} (category ${expectedCategory})`
    : floor.expectedStatus
  return evidence.task
    ? `; ${trackerReadback(evidence.task)}; expected ${expected}${pullRequest}`
    : ` reading back as ${floor.expectedStatus}${pullRequest}`
}

function pullRequestUnmetMessage(floor: Floor, evidence: ValidatedEvidence): string | null {
  if (floor.commandEvidence !== 'pull-request') return null
  if (floor.kind !== 'command-exit' && floor.kind !== 'recorded-artifact') return null
  const decision = decidePullRequestEvidence(pullRequestFacts(evidence))
  if (decision.met) return null
  const remedy =
    decision.condition === WITHHELD_PULL_REQUEST_CONDITION
      ? 'pass --artifact <pull-request link>'
      : floor.kind === 'command-exit'
        ? `pass --artifact exec:<id> from a successful \`${PLATFORM_SLUG} pr create\` command recorded for this step on this cursor's branch`
        : `pass --artifact <pull-request link> in this project's repository whose state is open or merged and whose head and base match this cursor`
  return `floor ${floor.kind} is unmet: ${decision.condition}; ${remedy}`
}

function floorUnmetMessage(floor: Floor, evidence: ValidatedEvidence): string {
  if (floor.kind === 'ruling' && floor.operatorRuling)
    return `floor ruling is unmet: no operator answer on this step; record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`
  if (floor.kind === 'command-exit' && floor.commandEvidence === 'gate')
    return gateFloorRefusal(
      evidence.tree ?? { project: 'this project', worktree: null, commit: null },
    )
  const pullRequest = pullRequestUnmetMessage(floor, evidence)
  if (pullRequest) return pullRequest
  const existing =
    `floor ${floor.kind} is unmet; pass ${flagForFloor(floor.kind)}` +
    (floor.kind === 'command-exit'
      ? ` with exit code ${floor.expectedExitCode}`
      : floor.kind === 'tracker-transition'
        ? trackerUnmetMessage(floor, evidence)
        : '')
  if (floor.kind === 'recorded-artifact' && evidence.runOffered !== undefined)
    return `${existing}; run ${evidence.runOffered} is accepted as --artifact ${evidence.runOffered} when it has a reply or a recorded artifact`
  if (floor.kind === 'command-exit' && evidence.artifactRunOffered !== undefined)
    return `${existing}; run ${evidence.artifactRunOffered} is accepted as --run ${evidence.artifactRunOffered} once terminal with exit code ${floor.expectedExitCode}`
  return existing
}

function unmetMessage(floors: Floor[], evidence: ValidatedEvidence): string {
  return floors.map((floor) => floorUnmetMessage(floor, evidence)).join('; ')
}

function commandExitFailureRefusal(
  floors: Floor[],
  evidence: ValidatedEvidence,
  met: Floor[],
): string | null {
  const exec = evidence.exec
  if (!exec || evidence.artifact?.ref !== `exec:${exec.recordId}`) return null
  if (!met.some((floor) => floor.kind === 'recorded-artifact')) return null
  if (met.some((floor) => floor.kind === 'command-exit')) return null
  const commandExit = floors.find((floor) => floor.kind === 'command-exit')
  if (!commandExit || exec.exitCode === commandExit.expectedExitCode) return null
  return commandExitMismatchRefusal({
    id: exec.id,
    command: exec.command,
    actualExitCode: exec.exitCode,
    expectedExitCode: commandExit.expectedExitCode,
  })
}

function operatorRulingBindingRefusal(floors: Floor[], evidence: ValidatedEvidence): string | null {
  if (!evidence.ruling || !floors.some((floor) => floor.operatorRuling)) return null
  return evidence.ruling.answered &&
    evidence.ruling.answeredByOperator &&
    evidence.ruling.boundToCursor &&
    evidence.ruling.boundToStep
    ? null
    : `floor ruling is unmet: no operator answer on this step; the supplied ruling cannot close it; record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`
}

function unfinishedReviewRefusal(floors: Floor[], evidence: ValidatedEvidence): string | null {
  const unfinished = evidence.review?.unfinishedReviewIds ?? []
  if (!unfinished.length || !floors.some((floor) => floor.kind === 'ruling')) return null
  return `floor ruling is unmet: review ids ${unfinished.join(', ')} in this round are unfinished`
}

function evidenceRefs(evidence: ValidatedEvidence): EvidenceRef[] {
  const refs: EvidenceRef[] = []
  if (evidence.ruling) refs.push({ flag: '--ruling', value: String(evidence.ruling.id) })
  if (evidence.review) refs.push({ flag: '--review', value: String(evidence.review.number) })
  if (evidence.gate) refs.push({ flag: '--gate', value: evidence.gate.recordId })
  if (evidence.run) refs.push({ flag: '--run', value: String(evidence.run.id) })
  if (evidence.artifact) refs.push({ flag: '--artifact', value: evidence.artifact.ref })
  if (evidence.task) refs.push({ flag: '--task', value: evidence.task.key })
  return refs
}

function refuseDefer(floors: Floor[]): FloorDecision {
  return {
    action: 'refuse',
    message:
      `this step's floors are not deferrable (${floors.map((floor) => floor.kind).join('|')}); ` +
      `pass evidence instead: ${unmetMessage(floors, {})}`,
  }
}

function refuseSatisfy(satisfy: ValidatedSatisfy): FloorDecision {
  if (!satisfy.found)
    return {
      action: 'refuse',
      message: `obligation ${satisfy.id} does not exist; pass a UUID from ${PLATFORM_SLUG} workflow cursors --json as --satisfies <obligation UUID>`,
    }
  if (!satisfy.cursorMatches)
    return {
      action: 'refuse',
      message: `obligation ${satisfy.id} belongs to another cursor`,
    }
  if (satisfy.abandoned)
    return {
      action: 'refuse',
      message: `obligation ${satisfy.id} is abandoned`,
    }
  if (!satisfy.open)
    return {
      action: 'refuse',
      message: `obligation ${satisfy.id} is already satisfied`,
    }
  return {
    action: 'refuse',
    message: `obligation ${satisfy.id} is unmet; pass ${flagForFloor(satisfy.floor.kind)} as evidence for that floor`,
  }
}

function refuseOpen(open: OpenObligation[]): FloorDecision {
  return {
    action: 'refuse',
    message:
      'workflow cannot finish while obligations are open: ' +
      open
        .map(
          (row) =>
            `obligation ${row.id} (step ${row.stepOrdinal} ${row.stepSlug} ${row.floor}) — pass --satisfies ${row.id} with ${flagForFloor(row.floor)}`,
        )
        .join('; '),
  }
}

function firstDeferrable(floors: Floor[]): Floor | undefined {
  return floors.find((floor) => floor.deferrable)
}

function deferralOf(
  floors: Floor[],
  evidence: ValidatedEvidence,
  alreadyMet: boolean,
): FloorDecision | { defer?: { floor: FloorKind; reason: string } } {
  const deferReason = evidence.deferReason?.trim()
  if (!deferReason) return {}
  const deferrable = firstDeferrable(floors)
  if (!deferrable) return refuseDefer(floors)
  if (alreadyMet) return {}
  return { defer: { floor: deferrable.kind, reason: deferReason } }
}

function satisfyOf(
  evidence: ValidatedEvidence,
  freshRulingAfter?: string,
): FloorDecision | { satisfyId?: string } {
  const satisfy = evidence.satisfy
  if (!satisfy) return {}
  if (
    !(
      satisfy.found &&
      satisfy.open &&
      !satisfy.abandoned &&
      satisfy.cursorMatches &&
      floorIsMet(satisfy.floor, evidence, freshRulingAfter)
    )
  )
    return refuseSatisfy(satisfy)
  return { satisfyId: satisfy.id }
}

function finishOf(
  finishing: boolean,
  remaining: OpenObligation[],
  deferred: { floor: FloorKind; reason: string } | undefined,
): FloorDecision | null {
  if (!finishing) return null
  if (deferred)
    return {
      action: 'refuse',
      message: `workflow cannot finish while deferring floor ${deferred.floor}; pass ${flagForFloor(deferred.floor)} instead of --defer`,
    }
  if (remaining.length) return refuseOpen(remaining)
  return null
}

export function decideFloorSatisfaction(input: FloorSatisfactionInput): FloorDecision {
  if (input.enforcement === 'note-only')
    return { action: 'allow', enforcement: 'note-only', refs: [] }
  const rulingRefusal = operatorRulingBindingRefusal(input.floors, input.evidence)
  if (rulingRefusal) return { action: 'refuse', message: rulingRefusal }
  const reviewRefusal = unfinishedReviewRefusal(input.floors, input.evidence)
  if (reviewRefusal) return { action: 'refuse', message: reviewRefusal }
  const met = input.floors.filter((floor) =>
    floorIsMet(floor, input.evidence, input.freshRulingAfter),
  )
  const commandFailure = commandExitFailureRefusal(input.floors, input.evidence, met)
  if (commandFailure) return { action: 'refuse', message: commandFailure }
  const bindingRefusal = commandExitBindingRefusal(
    input.evidence.exec,
    floorsAcceptPullRequestLink(input.floors),
  )
  if (
    met.length === 0 &&
    bindingRefusal &&
    input.floors.some((floor) => floor.kind === 'command-exit')
  )
    return { action: 'refuse', message: bindingRefusal }
  const deferred = deferralOf(input.floors, input.evidence, met.length > 0)
  if ('action' in deferred) return deferred
  if (met.length === 0 && !deferred.defer)
    return { action: 'refuse', message: unmetMessage(input.floors, input.evidence) }
  const satisfied = satisfyOf(input.evidence, input.freshRulingAfter)
  if ('action' in satisfied) return satisfied
  const remaining = input.openObligations.filter((row) => row.id !== input.evidence.satisfy?.id)
  const finishing = finishOf(input.finishing, remaining, deferred.defer)
  if (finishing) return finishing
  return {
    action: 'allow',
    enforcement: 'floors',
    refs: evidenceRefs(input.evidence),
    ...deferred,
    ...satisfied,
  }
}
