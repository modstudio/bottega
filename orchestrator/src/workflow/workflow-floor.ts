// concern: workflows
/** Pure floor-satisfaction for a workflow step. Must not know stores, processes, or clocks. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

type TrackerStateCategory = 'backlog' | 'open' | 'active' | 'review' | 'done' | 'dropped'
type TrackerStates = Record<string, TrackerStateCategory>

export const floorKinds = [
  'ruling',
  'command-exit',
  'recorded-artifact',
  'tracker-transition',
] as const
export type FloorKind = (typeof floorKinds)[number]
export type EnforcementMode = 'note-only' | 'floors'
export type CommandEvidence = 'gate'

export const floorGuidance = {
  ruling: `call \`await_workflow_ruling\` (or \`${PLATFORM_SLUG} workflow await\`), answer it with \`rule_workflow\`, then pass \`--ruling <the returned question id>\`; where you rule the step yourself, pass \`self_ruling\` with \`self_ruling_basis\` (or \`--self-ruling <text>\` with \`--basis <text>\`) on the closing call`,
  'command-exit': `run it with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass \`--artifact exec:<id>\``,
  'recorded-artifact':
    'record or attach the artifact and pass `--artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<id>>`',
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
  | { kind: 'probe'; id: number }
  | { kind: 'exec'; id: number }
  | { kind: 'doc'; address: string }
  | { kind: 'run'; id: string }
  | { kind: 'attached-text'; id: number }
  | { kind: 'id'; id: number }

type ValidatedSatisfy =
  | { id: number; found: false }
  | {
      id: number
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
  }
  review?: {
    recordId: string
    number: number
    allFindingsDisposed: boolean
    allLensesGraded: boolean
    unfinishedReviewIds?: number[]
  }
  gate?: {
    id: number
    finished: boolean
    exitCode: number | null
    project: string | null
    commit: string | null
  }
  run?: { id: string; terminal: boolean; exitCode: number | null }
  probe?: { id: number; exitCode: number }
  exec?: {
    id: number
    exitCode: number
    sessionMatches: boolean
    sessionAdoptedCursor: boolean
    createdAfterStepActivation: boolean
  }
  artifact?: { ref: string; exists: boolean }
  task?: {
    key: string
    status: string | null
    statusCategory: string | null
    mergedPullRequest: boolean
    trackerStates: TrackerStates
  }
  deferReason?: string
  satisfy?: ValidatedSatisfy
  tree?: { project: string; commit: string | null }
}

export type OpenObligation = {
  id: number
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
      satisfyId?: number
    }
  | { action: 'refuse'; message: string }

export type FloorSatisfactionInput = {
  floors: Floor[]
  evidence: ValidatedEvidence
  enforcement: EnforcementMode
  finishing: boolean
  openObligations: OpenObligation[]
}

export function flagForFloor(kind: FloorKind): string {
  if (kind === 'ruling') return '--ruling <question id> or --review <review id>'
  if (kind === 'command-exit')
    return '--gate <gate execution id> or --run <run id> or --artifact probe:<id> or --artifact exec:<id>'
  if (kind === 'recorded-artifact')
    return '--artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<id>>'
  if (kind === 'tracker-transition') return '--task <KEY>'
  throw new Error(`unknown floor kind "${String(kind)}"`)
}

export function parseArtifactRef(value: string): ArtifactRef | { error: string } {
  const trimmed = value.trim()
  const comment = /^task:([^#\s]+)#comment:(\S+)$/i.exec(trimmed)
  if (comment) return { kind: 'comment', key: comment[1]!.toUpperCase(), id: comment[2]! }
  const task = /^task:([^#\s]+)$/i.exec(trimmed)
  if (task) return { kind: 'task', key: task[1]!.toUpperCase() }
  const probe = /^probe:(\d+)$/i.exec(trimmed)
  if (probe) return { kind: 'probe', id: Number(probe[1]) }
  const exec = /^exec:(\d+)$/i.exec(trimmed)
  if (exec) return { kind: 'exec', id: Number(exec[1]) }
  const doc = /^doc:(\S+)$/i.exec(trimmed)
  if (doc) return { kind: 'doc', address: doc[1]! }
  const run = /^run:(\S+)$/i.exec(trimmed)
  if (run) return { kind: 'run', id: run[1]! }
  const attachedText = /^attached-text:(\d+)$/i.exec(trimmed)
  if (attachedText) return { kind: 'attached-text', id: Number(attachedText[1]) }
  if (/^\d+$/.test(trimmed)) return { kind: 'id', id: Number(trimmed) }
  return {
    error: `--artifact ${trimmed} is not doc:<scope>/<subject-or-_>/<slug>, doc:<UUID>, task:<KEY>, task:<KEY>#comment:<id>, a run number, probe:<id>, exec:<id>, or attached-text:<id>`,
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
      ...(kind === 'command-exit' && commandEvidence ? { commandEvidence } : {}),
    }))
  })
}

function catalogueFloorsFor(step: {
  floor: readonly string[]
  deferrable?: readonly string[]
  expectedStatus?: string | readonly string[]
  requirePullRequest?: boolean
  operatorRuling?: boolean
  commandEvidence?: CommandEvidence
}): Floor[] {
  return catalogueFloors(
    step.floor,
    step.deferrable,
    step.expectedStatus,
    step.requirePullRequest,
    step.operatorRuling,
    step.commandEvidence,
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
    return catalogueFloors(
      ['ruling'],
      step.deferrable,
      step.expectedStatus,
      step.requirePullRequest,
      step.operatorRuling,
      step.commandEvidence,
    )
  return catalogueFloorsFor(step)
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

function rulingMet(floor: Floor, evidence: ValidatedEvidence): boolean {
  const ruling = evidence.ruling
  const review = evidence.review
  const question = Boolean(
    ruling?.answered &&
      ruling.boundToCursor &&
      ruling.boundToStep &&
      (!floor.operatorRuling || ruling.answeredByOperator),
  )
  const triaged = Boolean(
    !floor.operatorRuling && review?.allFindingsDisposed && review.allLensesGraded,
  )
  return question || triaged
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

function floorIsMet(floor: Floor, evidence: ValidatedEvidence): boolean {
  if (floor.kind === 'ruling') return rulingMet(floor, evidence)
  if (floor.kind === 'command-exit') return commandExitMet(floor, evidence)
  if (floor.kind === 'recorded-artifact') return evidence.artifact?.exists === true
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

function floorUnmetMessage(floor: Floor, evidence: ValidatedEvidence): string {
  if (floor.kind === 'ruling' && floor.operatorRuling)
    return `floor ruling is unmet: no operator answer on this step; record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`
  if (floor.kind === 'command-exit' && floor.commandEvidence === 'gate') {
    const commit = evidence.tree?.commit ?? '<current tree commit>'
    return `floor command-exit is unmet: no passing gate record for ${evidence.tree?.project ?? 'this project'} commit ${commit}; run \`${PLATFORM_SLUG} gate run\` in the tree at commit ${commit}, then pass \`--gate <gate execution id>\``
  }
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

function commandExitBindingRefusal(evidence: ValidatedEvidence): string | null {
  const exec = evidence.exec
  if (!exec) return null
  const remedy = `run the command again with \`${PLATFORM_SLUG} workflow exec -- <command>\` in this session after the step started`
  if (!exec.sessionMatches && !exec.sessionAdoptedCursor)
    return `command-exit evidence exec:${exec.id} belongs to another session; ${remedy}`
  if (!exec.createdAfterStepActivation)
    return `command-exit evidence exec:${exec.id} predates this step becoming active; ${remedy}`
  return null
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
  if (evidence.gate) refs.push({ flag: '--gate', value: String(evidence.gate.id) })
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
      message: `obligation ${satisfy.id} does not exist; pass --satisfies <obligation id> from ${PLATFORM_SLUG} workflow listing`,
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

function satisfyOf(evidence: ValidatedEvidence): FloorDecision | { satisfyId?: number } {
  const satisfy = evidence.satisfy
  if (!satisfy) return {}
  if (
    !(
      satisfy.found &&
      satisfy.open &&
      !satisfy.abandoned &&
      satisfy.cursorMatches &&
      floorIsMet(satisfy.floor, evidence)
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
  const met = input.floors.filter((floor) => floorIsMet(floor, input.evidence))
  const bindingRefusal = commandExitBindingRefusal(input.evidence)
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
  const satisfied = satisfyOf(input.evidence)
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
