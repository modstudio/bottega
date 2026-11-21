// concern: workflows
/** Pure floor-satisfaction for a workflow step. Must not know stores, processes, or clocks. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { WITHHELD_SECRET_SHAPED } from '../../../shared/secret-shaped.ts'
import {
  taskOpenWithNotesFailures,
  taskOpenWithNotesMet,
} from './workflow-task-open-with-notes-floor.ts'

export { type ArtifactRef, parseArtifactRef } from './workflow-artifact-reference.ts'

import type {
  BottegaCommandIdentity,
  ValidatedArtifactEvidence,
} from './workflow-artifact-evidence.ts'
import type { CheckoutEvidenceLocation } from './workflow-checkout-refusal.ts'
import {
  commandExitBindingRefusal,
  commandExitMismatchRefusal,
  floorsAcceptPullRequestLink,
  gateFloorRefusal,
  type PassingGateForTree,
} from './workflow-floor-refusal.ts'
import {
  type DispatchWaiverFact,
  dispatchObligationRefusal,
  judgingObligationRefusal,
  type StepRunObligation,
  type WorkflowRunChainEvidence,
} from './workflow-run-obligation.ts'

type TrackerStateCategory = 'backlog' | 'open' | 'active' | 'review' | 'done' | 'dropped'
type TrackerStates = Record<string, TrackerStateCategory>

export const floorKinds = [
  'ruling',
  'command-exit',
  'recorded-artifact',
  'tracker-transition',
  'task-open-with-notes',
  'descendants-closed',
  'review-owed',
] as const
export type FloorKind = (typeof floorKinds)[number]
export type EnforcementMode = 'note-only' | 'floors'
export type CommandEvidence = 'gate' | 'pull-request'

export function hasGateFloor(
  floors: ReadonlyArray<{ kind: string; commandEvidence?: string }>,
): boolean {
  return floors.some((floor) => floor.kind === 'command-exit' && floor.commandEvidence === 'gate')
}

const ARTIFACT_FORMS =
  'doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | note:<record-id|label> | run number or run id | probe:<id> | exec:<id> | review-read:<UUID> | attached-text:<UUID> | #<pull request number> | GitHub pull-request link | a commit SHA'

export const floorGuidance = {
  ruling: `call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\`; where you rule the step yourself, pass \`self_ruling\` with \`self_ruling_basis\` (or \`--self-ruling <text>\` with \`--basis <text>\`) on the closing call`,
  'command-exit': `run it with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass \`--artifact exec:<id>\`, pass \`--gate <gate execution id>\` for a gate floor, or pass \`--run <run id>\` for a run-backed command`,
  'recorded-artifact': `record or attach the artifact and pass \`--artifact <${ARTIFACT_FORMS}>\``,
  'tracker-transition': 'make the tracker transition and pass `--task <KEY>`',
  'task-open-with-notes':
    'leave the task open, then pass `--task <KEY>` and at least one `--artifact note:<record-id|label>` for an open note attached to that task',
  'descendants-closed':
    'finish or drop every descendant, move the epic to done, and pass `--task <KEY>`',
  'review-owed': `run \`${PLATFORM_SLUG} review tier <branch>\` and follow its remedy until no lens is owed`,
} satisfies Record<FloorKind, string>

export function evidenceGuidance(
  kind: FloorKind,
  operatorRuling: boolean,
  hasOtherFloor = false,
): string {
  if (kind === 'ruling' && operatorRuling)
    return `only the operator's answer closes this floor: ask with \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), have the operator answer, or relay the operator's answer with \`rule_workflow\` \`from_operator\` (or \`${PLATFORM_SLUG} workflow rule --from-operator\`), then pass \`--ruling <the returned question id>\`${hasOtherFloor ? "; another floor's evidence closes this step instead (any one floor is enough)" : ''}`
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
  artifacts?: ValidatedArtifactEvidence[]
  strandedQuestionRemedy?: string
  stepQuestion?: {
    id: number
    state: 'open' | 'closed' | 'answered-by-operator' | 'answered-by-agent' | 'overturned'
    answeredAt: string | null
    replacement: string | null
  }
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
  passingGateForTree?: PassingGateForTree
  run?: { id: string; terminal: boolean; exitCode: number | null }
  task?: {
    key: string
    status: string | null
    statusCategory: string | null
    mergedPullRequest: boolean | null
    pullRequestUnavailable?:
      | { kind: 'unrecorded'; reason: string; branch: string }
      | { kind: 'read-error'; reason: string }
    trackerStates: TrackerStates
  }
  notes?: Array<{
    reference: string
    recordId: string | null
    label: string | null
    promotedTask: string | null
    staleAt: string | null
  }>
  descendants?: Array<{ key: string; status: string | null; statusCategory: string | null }>
  deferReason?: string
  satisfy?: ValidatedSatisfy
  tree?: { project: string; worktree?: string | null; commit: string | null }
  dispatchRuns?: WorkflowRunChainEvidence[]
  judgedRuns?: WorkflowRunChainEvidence[]
  metDispatchWaiverFacts?: DispatchWaiverFact[]
}

export const isOperatorRulingFloor = (floor: Pick<Floor, 'kind' | 'operatorRuling'>): boolean =>
  floor.kind === 'ruling' && floor.operatorRuling

export type OpenObligation = {
  id: string
  stepOrdinal: number
  stepSlug: string
  floorDefinition: Floor
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
  cursorTakeoverRemedy?: string
  workflowKey?: string
  step?: StepRunObligation
}

export function flagForFloor(kind: FloorKind): string {
  if (kind === 'ruling') return '--ruling <question id> or --review <review id>'
  if (kind === 'command-exit')
    return '--gate <gate execution id> or --run <run id> or --artifact probe:<id> or --artifact exec:<id>'
  if (kind === 'recorded-artifact') return `--artifact <${ARTIFACT_FORMS}>`
  if (kind === 'tracker-transition' || kind === 'descendants-closed') return '--task <KEY>'
  if (kind === 'task-open-with-notes') return '--task <KEY> and --artifact note:<record-id|label>'
  if (kind === 'review-owed')
    return `follow the remedy from \`${PLATFORM_SLUG} review tier <branch>\``
  throw new Error(`unknown floor kind "${String(kind)}"`)
}

export function closingFlagsForFloor(
  floor: Pick<Floor, 'kind' | 'operatorRuling' | 'commandEvidence'>,
): string {
  if (isOperatorRulingFloor(floor)) return '--ruling <question id>'
  if (floor.kind === 'command-exit' && floor.commandEvidence === 'gate')
    return '--gate <gate execution id>'
  if (floor.commandEvidence === 'pull-request')
    return floor.kind === 'command-exit' ? '--artifact exec:<id>' : '--artifact <pull-request link>'
  return flagForFloor(floor.kind)
}

export type ReviewReadArtifactDecision = { accepted: true } | { accepted: false; message: string }

/** Accepts an architect read only when it records this cursor's current branch tip. */
export function decideReviewReadArtifact(input: {
  reviewedCommit: string
  branchTip: string | null
}): ReviewReadArtifactDecision {
  if (input.branchTip === null)
    return {
      accepted: false,
      message:
        'this cursor records no worktree, so its branch tip cannot be established; pass `--arg worktree=<tree>` on the cursor to clear this refusal',
    }
  if (input.reviewedCommit === input.branchTip) return { accepted: true }
  return {
    accepted: false,
    message: `review-read commit ${input.reviewedCommit} is not this cursor's branch tip ${input.branchTip}; record a fresh read with \`${PLATFORM_SLUG} review read --cwd <tree> --sha <tip> --note <text>\` and pass its id as \`--artifact review-read:<UUID>\``,
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
  outcomeFloors?: Readonly<Record<string, readonly string[]>>
}

/** Floors that apply to a close: a ruling outcome (or a forced ruling) replaces the ordinary floor. */
export function decideCloseFloors(
  step: CloseFloorStep,
  outcome: string | undefined,
  forceRuling = false,
): Floor[] {
  if (forceRuling || (outcome !== undefined && step.rulingOutcomes?.includes(outcome)))
    return catalogueFloorsFor(step, outcome, ['ruling'])
  return catalogueFloorsFor(step, outcome, outcome ? step.outcomeFloors?.[outcome] : undefined)
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
      checkoutLocation: CheckoutEvidenceLocation
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

const WITHHELD_PULL_REQUEST_CONDITION =
  'the recorded output was withheld, so the pull-request URL cannot be read'
const WITHHELD_PULL_REQUEST_COMMAND_CONDITION = `the recorded command was withheld, so it cannot be identified as ${PLATFORM_SLUG} pr create`

function execOutputWithheld(facts: { outputWithheld: boolean; output: string }): boolean {
  return facts.outputWithheld || facts.output === WITHHELD_SECRET_SHAPED
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
  if (!facts.headCommit) return { met: false, condition: 'the recorded command has no head commit' }
  if (facts.checkoutLocation === 'outside-change')
    return {
      met: false,
      condition: `the recorded command head commit does not belong to this cursor's ${facts.cursorBranch} change`,
    }
  const pullRequestUrl = githubPullRequestUrlIn(facts.output)
  if (!pullRequestUrl && execOutputWithheld(facts))
    return { met: false, condition: WITHHELD_PULL_REQUEST_CONDITION }
  if (!pullRequestUrl)
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
  evidence: ValidatedArtifactEvidence,
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
    checkoutLocation: exec.checkoutLocation,
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
  evidence: ValidatedArtifactEvidence,
): Extract<PullRequestEvidenceFacts, { kind: 'link' }> | undefined {
  return evidence.pullRequest ? { kind: 'link', ...evidence.pullRequest } : undefined
}

function pullRequestFacts(
  evidence: ValidatedArtifactEvidence,
): PullRequestEvidenceFacts | undefined {
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
  const artifactOk = (evidence.artifacts ?? []).some(
    (entry) =>
      entry.probe?.exitCode === floor.expectedExitCode ||
      (entry.exec?.exitCode === floor.expectedExitCode &&
        (entry.exec.sessionMatches || entry.exec.sessionAdoptedCursor) &&
        entry.exec.createdAfterStepActivation),
  )
  if (floor.commandEvidence === 'pull-request')
    return (evidence.artifacts ?? []).some(
      (entry) => decidePullRequestEvidence(pullRequestFacts(entry)).met,
    )
  return gateOk || runOk || artifactOk
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
  return !floor.requirePullRequest || task.mergedPullRequest === true
}

function floorIsMet(
  floor: Floor,
  evidence: ValidatedEvidence,
  freshRulingAfter?: string,
  workflowKey?: string,
): boolean {
  if (floor.kind === 'ruling') return rulingMet(floor, evidence, freshRulingAfter)
  if (floor.kind === 'command-exit') return commandExitMet(floor, evidence)
  if (floor.kind === 'recorded-artifact')
    return floor.commandEvidence === 'pull-request'
      ? (evidence.artifacts ?? []).some(
          (entry) => decidePullRequestEvidence(pullRequestFacts(entry)).met,
        )
      : (evidence.artifacts ?? []).some((entry) => entry.artifact.exists)
  if (floor.kind === 'tracker-transition') return taskMet(floor, evidence)
  if (floor.kind === 'task-open-with-notes') return taskOpenWithNotesMet(evidence, workflowKey)
  if (floor.kind === 'descendants-closed')
    return (
      taskMet(floor, evidence) &&
      (evidence.descendants ?? []).every(
        (task) => task.statusCategory === 'done' || task.statusCategory === 'dropped',
      )
    )
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
  const unavailable =
    floor.requirePullRequest && evidence.task?.pullRequestUnavailable
      ? evidence.task.pullRequestUnavailable.kind === 'unrecorded'
        ? `; pull request merge state could not be established: ${evidence.task.pullRequestUnavailable.reason}; record it with: ${PLATFORM_SLUG} tree branch landed ${evidence.task.pullRequestUnavailable.branch} --pr <number>`
        : `; pull request merge state could not be established: ${evidence.task.pullRequestUnavailable.reason}; rerun the close when GitHub is reachable`
      : ''
  const expectation = evidence.task
    ? `; ${trackerReadback(evidence.task)}; expected ${expected}${pullRequest}`
    : ` reading back as ${floor.expectedStatus}${pullRequest}`
  return `${expectation}${unavailable}`
}

function taskOpenWithNotesUnmetMessage(evidence: ValidatedEvidence, workflowKey?: string): string {
  const failures = taskOpenWithNotesFailures(evidence, workflowKey)
  return `floor task-open-with-notes is unmet: ${failures.join('; ')}; leave ${workflowKey ?? 'the cursor task'} open and retry with --task <KEY> and --artifact note:<record-id|label> for every note named`
}

function pullRequestUnmetMessage(floor: Floor, evidence: ValidatedEvidence): string | null {
  if (floor.commandEvidence !== 'pull-request') return null
  if (floor.kind !== 'command-exit' && floor.kind !== 'recorded-artifact') return null
  const facts = (evidence.artifacts ?? [])
    .map(pullRequestFacts)
    .find((entry) => entry !== undefined)
  const decision = decidePullRequestEvidence(facts)
  if (decision.met) return null
  const remedy =
    decision.condition === WITHHELD_PULL_REQUEST_CONDITION
      ? 'pass --artifact <pull-request link>'
      : floor.kind === 'command-exit'
        ? `pass --artifact exec:<id> from a successful \`${PLATFORM_SLUG} pr create\` command recorded for this step on this cursor's branch`
        : `pass --artifact <pull-request link> in this project's repository whose state is open or merged and whose head and base match this cursor`
  return `floor ${floor.kind} is unmet: ${decision.condition}; ${remedy}`
}

function floorUnmetMessage(
  floor: Floor,
  evidence: ValidatedEvidence,
  freshRulingAfter?: string,
  workflowKey?: string,
): string {
  if (floor.kind === 'task-open-with-notes')
    return taskOpenWithNotesUnmetMessage(evidence, workflowKey)
  if (floor.kind === 'descendants-closed') {
    const unfinished = (evidence.descendants ?? []).filter(
      (task) => task.statusCategory !== 'done' && task.statusCategory !== 'dropped',
    )
    if (unfinished.length)
      return `floor descendants-closed is unmet; unfinished descendants: ${unfinished.map((task) => `${task.key} (${task.status ?? task.statusCategory ?? 'unset'})`).join(', ')}; finish or drop them, move the epic to done, then pass --task <KEY>`
  }
  if (isOperatorRulingFloor(floor))
    return operatorRulingRemedy(
      evidence.stepQuestion,
      evidence.ruling?.id,
      freshRulingAfter,
      evidence.strandedQuestionRemedy,
    )
  if (floor.kind === 'command-exit' && floor.commandEvidence === 'gate')
    return gateFloorRefusal(
      evidence.tree ?? { project: 'this project', worktree: null, commit: null },
      evidence.passingGateForTree,
      evidence.gate !== undefined,
    )
  const pullRequest = pullRequestUnmetMessage(floor, evidence)
  if (pullRequest) return pullRequest
  const existing =
    `floor ${floor.kind} is unmet; pass ${closingFlagsForFloor(floor)}` +
    (floor.kind === 'command-exit'
      ? ` with exit code ${floor.expectedExitCode}`
      : floor.kind === 'tracker-transition' || floor.kind === 'descendants-closed'
        ? trackerUnmetMessage(floor, evidence)
        : '')
  if (floor.kind === 'recorded-artifact' && evidence.runOffered !== undefined)
    return `${existing}; run ${evidence.runOffered} is accepted as --artifact ${evidence.runOffered} when it has a reply or a recorded artifact`
  const artifactRunOffered = evidence.artifacts?.find(
    (entry) => entry.artifactRunOffered !== undefined,
  )?.artifactRunOffered
  if (floor.kind === 'command-exit' && artifactRunOffered !== undefined)
    return `${existing}; run ${artifactRunOffered} is accepted as --run ${artifactRunOffered} once terminal with exit code ${floor.expectedExitCode}`
  return existing
}

function operatorRulingRemedy(
  question: ValidatedEvidence['stepQuestion'],
  suppliedRuling?: number,
  freshRulingAfter?: string,
  strandedQuestionRemedy?: string,
): string {
  if (!question) return missingOperatorQuestionRemedy(suppliedRuling, strandedQuestionRemedy)
  if (question.state === 'closed')
    return `floor ruling is unmet: the step's question ${question.id} is closed; ${suppliedRuling ? 'the supplied ruling cannot close it; ' : ''}record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`
  if (question.state === 'open')
    return `floor ruling is unmet: the step's question ${question.id} is open; ${suppliedRuling ? 'the supplied ruling cannot close it; ' : ''}the operator answers it with \`${PLATFORM_SLUG} workflow rule --from-operator\`, then close with \`--ruling ${question.id}\``
  if (question.state === 'overturned')
    return overturnedQuestionRemedy(question, suppliedRuling !== undefined)
  if (
    question.state === 'answered-by-operator' &&
    freshRulingAfter !== undefined &&
    (!question.answeredAt || question.answeredAt <= freshRulingAfter)
  )
    return `floor ruling is unmet: the step was re-entered after the operator answered question ${question.id}; record the question again with \`${PLATFORM_SLUG} workflow await\` for a fresh operator answer`
  if (question.state === 'answered-by-operator')
    return `floor ruling is unmet: ${suppliedOperatorRulingRefusal(suppliedRuling, question.id)}the operator answered the step's question ${question.id}; close with \`--ruling ${question.id}\``
  return `floor ruling is unmet: question ${question.id} was answered by an agent, which cannot close an operator floor; ${suppliedRuling ? 'the supplied ruling cannot close it; ' : ''}record the question for the operator with \`${PLATFORM_SLUG} workflow await\``
}

function missingOperatorQuestionRemedy(
  suppliedRuling?: number,
  strandedQuestionRemedy?: string,
): string {
  if (strandedQuestionRemedy)
    return `floor ruling is unmet: ${suppliedRuling ? `the supplied ruling ${suppliedRuling} cannot close the step; ` : ''}${strandedQuestionRemedy}`
  return `floor ruling is unmet: no operator answer on this step; ${suppliedRuling ? 'the supplied ruling cannot close it; ' : ''}record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`
}

function overturnedQuestionRemedy(
  question: NonNullable<ValidatedEvidence['stepQuestion']>,
  rulingSupplied: boolean,
): string {
  const replacement =
    question.replacement === null ? '' : ` with replacement "${question.replacement}"`
  const supplied = rulingSupplied ? 'the supplied ruling cannot close it; ' : ''
  return `floor ruling is unmet: question ${question.id} was overturned${replacement}; ${supplied}record the question again for the operator with \`${PLATFORM_SLUG} workflow await\``
}

function suppliedOperatorRulingRefusal(
  suppliedRuling: number | undefined,
  questionId: number,
): string {
  if (!suppliedRuling) return ''
  if (suppliedRuling !== questionId)
    return `the supplied ruling ${suppliedRuling} cannot close the step; `
  return 'the supplied ruling cannot close the step; '
}

function unmetMessage(
  floors: Floor[],
  evidence: ValidatedEvidence,
  freshRulingAfter?: string,
  workflowKey?: string,
): string {
  if (floors.length === 1)
    return floorUnmetMessage(floors[0]!, evidence, freshRulingAfter, workflowKey)
  const ordinary = floors.filter((floor) => !isOperatorRulingFloor(floor))
  const operator = floors.filter(isOperatorRulingFloor)
  const remedies = ordinary.map((floor) =>
    floorUnmetMessage(floor, evidence, freshRulingAfter, workflowKey),
  )
  if (operator.length === 0) return `${remedies.join('; ')}; any one floor is enough`
  const operatorRemedies = operator.map((floor) =>
    floorUnmetMessage(floor, evidence, freshRulingAfter, workflowKey),
  )
  if (ordinary.length === 0) return `${operatorRemedies.join('; ')}; any one floor is enough`
  return `${remedies.join('; ')}; any one floor is enough; a person's ruling is needed only when that other evidence does not close the step — ${operatorRemedies.join('; ')}`
}

function commandExitFailureRefusal(
  floors: Floor[],
  evidence: ValidatedEvidence,
  met: Floor[],
): string | null {
  if (!met.some((floor) => floor.kind === 'recorded-artifact')) return null
  if (met.some((floor) => floor.kind === 'command-exit')) return null
  const commandExit = floors.find((floor) => floor.kind === 'command-exit')
  if (!commandExit) return null
  const exec = evidence.artifacts
    ?.filter((entry) => entry.artifact.ref === `exec:${entry.exec?.recordId}`)
    .map((entry) => entry.exec)
    .find((entry) => entry !== undefined && entry.exitCode !== commandExit.expectedExitCode)
  if (!exec) return null
  return commandExitMismatchRefusal({
    id: exec.id,
    command: exec.command,
    actualExitCode: exec.exitCode,
    expectedExitCode: commandExit.expectedExitCode,
  })
}

function operatorRulingBindingRefusal(
  floors: Floor[],
  evidence: ValidatedEvidence,
  freshRulingAfter?: string,
): string | null {
  if (!evidence.ruling || !floors.some(isOperatorRulingFloor)) return null
  return evidence.ruling.answered &&
    evidence.ruling.answeredByOperator &&
    evidence.ruling.boundToCursor &&
    evidence.ruling.boundToStep
    ? null
    : operatorRulingRemedy(
        evidence.stepQuestion,
        evidence.ruling.id,
        freshRulingAfter,
        evidence.strandedQuestionRemedy,
      )
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
  const artifactRefs = new Set<string>()
  for (const entry of evidence.artifacts ?? []) {
    if (artifactRefs.has(entry.artifact.ref)) continue
    artifactRefs.add(entry.artifact.ref)
    refs.push({ flag: '--artifact', value: entry.artifact.ref })
  }
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
    message: `obligation ${satisfy.id} is unmet; pass ${closingFlagsForFloor(satisfy.floor)} as evidence for that floor`,
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
            `obligation ${row.id} (step ${row.stepOrdinal} ${row.stepSlug} ${row.floorDefinition.kind}) — pass --satisfies ${row.id} with ${closingFlagsForFloor(row.floorDefinition)}`,
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
  workflowKey?: string,
): FloorDecision | { satisfyId?: string } {
  const satisfy = evidence.satisfy
  if (!satisfy) return {}
  if (
    !(
      satisfy.found &&
      satisfy.open &&
      !satisfy.abandoned &&
      satisfy.cursorMatches &&
      floorIsMet(satisfy.floor, evidence, freshRulingAfter, workflowKey)
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
  const rulingRefusal = operatorRulingBindingRefusal(
    input.floors,
    input.evidence,
    input.freshRulingAfter,
  )
  if (rulingRefusal) return { action: 'refuse', message: rulingRefusal }
  const reviewRefusal = unfinishedReviewRefusal(input.floors, input.evidence)
  if (reviewRefusal) return { action: 'refuse', message: reviewRefusal }
  const met = input.floors.filter((floor) =>
    floorIsMet(floor, input.evidence, input.freshRulingAfter, input.workflowKey),
  )
  const obligationInput = {
    workflowKey: input.workflowKey,
    selectedFloors: input.floors.map((floor) => floor.kind),
    metWaiverFacts: input.evidence.metDispatchWaiverFacts ?? [],
    step: input.step,
    dispatchRuns: input.evidence.dispatchRuns,
    judgedRuns: input.evidence.judgedRuns,
  }
  const dispatchRefusal = dispatchObligationRefusal(obligationInput)
  if (dispatchRefusal) return { action: 'refuse', message: dispatchRefusal }
  const judgingRefusal = judgingObligationRefusal(obligationInput)
  if (judgingRefusal) return { action: 'refuse', message: judgingRefusal }
  const commandFailure = commandExitFailureRefusal(input.floors, input.evidence, met)
  if (commandFailure) return { action: 'refuse', message: commandFailure }
  const bindingRefusal = input.evidence.artifacts
    ?.map((entry) =>
      commandExitBindingRefusal(
        entry.exec,
        floorsAcceptPullRequestLink(input.floors),
        input.cursorTakeoverRemedy,
      ),
    )
    .find((refusal) => refusal !== null)
  if (
    met.length === 0 &&
    bindingRefusal &&
    input.floors.some((floor) => floor.kind === 'command-exit')
  )
    return { action: 'refuse', message: bindingRefusal }
  const deferred = deferralOf(input.floors, input.evidence, met.length > 0)
  if ('action' in deferred) return deferred
  if (met.length === 0 && input.floors.length > 0 && !deferred.defer)
    return {
      action: 'refuse',
      message: unmetMessage(
        input.floors,
        input.evidence,
        input.freshRulingAfter,
        input.workflowKey,
      ),
    }
  const satisfied = satisfyOf(input.evidence, input.freshRulingAfter, input.workflowKey)
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
