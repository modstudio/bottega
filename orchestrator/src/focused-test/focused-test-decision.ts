// concern: focused-test-decision
/** Pure contracts and decisions for project-registered focused test runs. */

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const FOCUSED_TEST_MAX_PATHS = 64
/** What one affected-test selector may print before its selection is refused rather than held. */
export const FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES = 1024 * 1024
const FOCUSED_TEST_OUTPUT_TAIL_BYTES = 16 * 1024

/** A registered command: fixed executable and argv prefix. */
type FocusedTestCommand = { command: string; args: string[] }
export type FocusedTestRunner = FocusedTestCommand & {
  affected?: FocusedTestSelector
  patterns?: string[]
}
/** The command that prints this project's affected test paths for one base commit. */
export type FocusedTestSelector = FocusedTestCommand
/** The `focusedTests` object a project's settings declare. */
export type FocusedTestDeclaration =
  | (FocusedTestCommand & { affected?: FocusedTestSelector })
  | { runners: FocusedTestRunner[] }

type FocusedTestCommandValidation = {
  command: FocusedTestCommand | null
  problems: string[]
}
export type FocusedTestDeclarationValidation = {
  runners: FocusedTestRunner[]
  problems: string[]
}
export type FocusedTestRequest = { id: string; paths: string[]; affected: boolean }
export type FocusedTestResult = {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  logName: string
  outputTail: string
}

export type FocusedTestEligibility = { eligible: true } | { eligible: false; message: string }

/** Why a focused test execution stopped without a result of its own. */
export const FOCUSED_TEST_CLOSE_REASON =
  'Focused test run cancelled because the supervising run closed.'

export function decideFocusedTestEligibility(input: {
  authenticated: boolean
  writer: boolean
  runner: FocusedTestRunner | null
  selector: FocusedTestSelector | null
  /** The problems a declared `focusedTests.affected` block carries, if it declares any. */
  selectorProblem: string | null
  affected: boolean
}): FocusedTestEligibility {
  if (!input.authenticated) {
    return { eligible: false, message: 'This process is not a recognized orchestrator worker.' }
  }
  if (!input.writer) {
    return { eligible: false, message: 'run_tests is available only to a writing worker run.' }
  }
  if (!input.runner) {
    return {
      eligible: false,
      message: "This run's project has no registered focused test runner, so nothing was run.",
    }
  }
  if (input.affected) {
    if (input.selectorProblem) {
      return { eligible: false, message: affectedSelectorProblemMessage(input.selectorProblem) }
    }
    if (!input.selector) {
      return { eligible: false, message: affectedSelectorRegisterMessage() }
    }
  }
  return { eligible: true }
}

/**
 * The refusal a call asking for affected tests earns when its project declares a
 * `focusedTests.affected` block that cannot be read. The problem names the register key.
 */
function affectedSelectorProblemMessage(problem: string): string {
  return (
    `This run's project declares focusedTests.affected, but run_tests cannot read it: ${problem}. ` +
    'Fix it in the project register settings, or call run_tests without affected to run the ' +
    'registered runner.'
  )
}

/** The refusal a call asking for affected tests earns when its project declares no selector. */
function affectedSelectorRegisterMessage(): string {
  return (
    "This run's project declares no affected-test selector, so run_tests cannot select the tests " +
    'that import what this run changed. Declare focusedTests.affected, a command and args, in the ' +
    "project's register settings to add one."
  )
}

export type FocusedTestRequestDecision =
  | { action: 'start' }
  | { action: 'join'; execution: FocusedTestRequest }
  | { action: 'return'; execution: FocusedTestRequest }

/** Decide whether one worker call starts, joins, or collects a focused-test execution. */
export function decideFocusedTestRequest(input: {
  execution: FocusedTestRequest | null
  finished: boolean
  resultPending: boolean
}): FocusedTestRequestDecision {
  if (!input.execution) return { action: 'start' }
  if (!input.finished) return { action: 'join', execution: input.execution }
  if (input.resultPending) return { action: 'return', execution: input.execution }
  return { action: 'start' }
}

function formatFocusedTestPaths(paths: readonly string[]): string {
  return paths.map((path) => JSON.stringify(path)).join(', ')
}

export function formatFocusedTestRequestDecision(
  decision: FocusedTestRequestDecision,
  requestedPaths: readonly string[],
): string | null {
  if (decision.action === 'join') {
    return (
      `Focused tests for ${formatFocusedTestPaths(decision.execution.paths)} were already running; ` +
      `this call ignored its requested paths (${formatFocusedTestPaths(requestedPaths)}) and waited for the same execution.`
    )
  }
  if (decision.action === 'return') {
    return (
      `Focused tests for ${formatFocusedTestPaths(decision.execution.paths)} finished after an earlier ` +
      'run_tests call stopped waiting; returning that result.'
    )
  }
  return null
}

export function decideFocusedTestWait(input: {
  finished: boolean
  waitElapsedMs: number
  paths: readonly string[]
  waitMs: number
}): { wait: true } | { wait: false; message?: string } {
  if (input.finished) return { wait: false }
  if (input.waitElapsedMs < input.waitMs) return { wait: true }
  return {
    wait: false,
    message:
      `Focused tests for ${formatFocusedTestPaths(input.paths)} are still running. ` +
      'Call run_tests again to wait for and collect this same execution.',
  }
}

function parseStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${location} must be an array of strings`)
  }
  return value as string[]
}

/**
 * The rules one registered command must satisfy, reported against the register key that holds it.
 * A command absent or null declares nothing and is no problem; a present one must name a
 * non-empty executable and an argv prefix of strings.
 */
function validateFocusedTestCommand(
  value: unknown,
  location: string,
): FocusedTestCommandValidation {
  if (value === undefined || value === null) return { command: null, problems: [] }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { command: null, problems: [`${location} must be an object`] }
  }
  const candidate = value as Record<string, unknown>
  const problems: string[] = []
  if (typeof candidate.command !== 'string' || !candidate.command.trim()) {
    problems.push(`${location}.command must be a non-empty string`)
  }
  if (!Array.isArray(candidate.args) || candidate.args.some((item) => typeof item !== 'string')) {
    problems.push(`${location}.args must be an array of strings`)
  }
  if (problems.length) return { command: null, problems }
  return {
    command: { command: (candidate.command as string).trim(), args: candidate.args as string[] },
    problems: [],
  }
}

function validateFocusedTestPatterns(input: {
  value: unknown
  location: string
  multipleRunners: boolean
  claimedPatterns: Set<string>
}): { patterns: string[] | undefined; problems: string[] } {
  if (input.value === undefined) {
    return {
      patterns: undefined,
      problems: input.multipleRunners
        ? [`${input.location}.patterns is required when focusedTests declares multiple runners`]
        : [],
    }
  }
  if (
    !Array.isArray(input.value) ||
    input.value.length === 0 ||
    input.value.some((pattern) => typeof pattern !== 'string' || !pattern.trim())
  ) {
    return {
      patterns: undefined,
      problems: [`${input.location}.patterns must be a non-empty array of non-empty strings`],
    }
  }
  const patterns = input.value.map((pattern) => String(pattern).trim())
  const problems: string[] = []
  for (const pattern of patterns) {
    if (input.claimedPatterns.has(pattern)) {
      problems.push(
        `focusedTests path pattern ${JSON.stringify(pattern)} is claimed by two runners`,
      )
    }
    input.claimedPatterns.add(pattern)
    try {
      new Bun.Glob(pattern)
    } catch {
      problems.push(
        `${input.location}.patterns contains invalid pattern ${JSON.stringify(pattern)}`,
      )
    }
  }
  return { patterns, problems }
}

/** The runner and selector parts of one `focusedTests` value, validated independently. */
function focusedTestDeclarationParts(value: unknown): {
  runners: FocusedTestRunner[]
  runnerProblems: string[]
  selector: FocusedTestCommandValidation
} {
  if (value === undefined || value === null) {
    return {
      runners: [],
      runnerProblems: [],
      selector: { command: null, problems: [] },
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    const shape = ['focusedTests must be an object']
    return {
      runners: [],
      runnerProblems: shape,
      selector: { command: null, problems: shape },
    }
  }
  const candidate = value as Record<string, unknown>
  if (candidate.runners !== undefined) {
    if (!Array.isArray(candidate.runners) || candidate.runners.length === 0) {
      return {
        runners: [],
        runnerProblems: ['focusedTests.runners must be a non-empty array'],
        selector: { command: null, problems: [] },
      }
    }
    const declaredRunners = candidate.runners
    const runners: FocusedTestRunner[] = []
    const problems: string[] = []
    const claimedPatterns = new Set<string>()
    declaredRunners.forEach((entry, index) => {
      const location = `focusedTests.runners[${index}]`
      const command = validateFocusedTestCommand(entry, location)
      problems.push(...command.problems)
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
      const declared = entry as Record<string, unknown>
      const affected = validateFocusedTestCommand(declared.affected, `${location}.affected`)
      problems.push(...affected.problems)
      const { patterns, problems: patternProblems } = validateFocusedTestPatterns({
        value: declared.patterns,
        location,
        multipleRunners: declaredRunners.length > 1,
        claimedPatterns,
      })
      problems.push(...patternProblems)
      if (command.command && !affected.problems.length) {
        runners.push({
          ...command.command,
          ...(affected.command ? { affected: affected.command } : {}),
          ...(patterns ? { patterns } : {}),
        })
      }
    })
    return {
      runners: problems.length ? [] : runners,
      runnerProblems: problems,
      selector: { command: null, problems: [] },
    }
  }
  const legacyRunner = validateFocusedTestCommand(
    { command: candidate.command, args: candidate.args },
    'focusedTests',
  )
  const legacySelector = validateFocusedTestCommand(candidate.affected, 'focusedTests.affected')
  return {
    runners: legacyRunner.command
      ? [
          {
            ...legacyRunner.command,
            ...(legacySelector.command ? { affected: legacySelector.command } : {}),
          },
        ]
      : [],
    runnerProblems: legacyRunner.problems,
    selector: legacySelector,
  }
}

export function validateFocusedTestDeclaration(value: unknown): FocusedTestDeclarationValidation {
  const parts = focusedTestDeclarationParts(value)
  return {
    runners: parts.runners,
    problems: [...new Set([...parts.runnerProblems, ...parts.selector.problems])],
  }
}

export function hasFocusedTestRunner(value: unknown): boolean {
  return validateFocusedTestDeclaration(value).runners.length > 0
}

/**
 * The commands a project's stored settings declare, read independently: the runner and the optional
 * selector are separate declarations, so a malformed `focusedTests.affected` never costs the runner
 * its registration — it leaves `selector` null and reports why in `selectorProblem`. Settings that
 * cannot be parsed at all register nothing rather than refusing here: absence is what the callers
 * report.
 */
export function declaredFocusedTestCommands(settings: string | null): {
  runners: FocusedTestRunner[]
  selector: FocusedTestSelector | null
  selectorProblem: string | null
} {
  let parsed: { focusedTests?: unknown } | null
  try {
    parsed = JSON.parse(settings ?? '{}') as { focusedTests?: unknown } | null
  } catch {
    return { runners: [], selector: null, selectorProblem: null }
  }
  const parts = focusedTestDeclarationParts(parsed?.focusedTests)
  return {
    runners: parts.runnerProblems.length ? [] : parts.runners,
    selector: parts.selector.problems.length
      ? null
      : parts.runners.length === 1
        ? (parts.runners[0]?.affected ?? parts.selector.command)
        : parts.runners.every((runner) => runner.affected)
          ? (parts.runners[0]?.affected ?? null)
          : null,
    selectorProblem:
      [
        ...parts.selector.problems,
        ...(parts.runners.length > 1 && parts.runners.some((runner) => !runner.affected)
          ? ['every focusedTests.runners entry must declare affected for an affected run']
          : []),
      ].join('; ') || null,
  }
}

type FocusedTestRunnerGroup = { runner: FocusedTestRunner; paths: string[] }
export type FocusedTestRunnerSplit =
  | { kind: 'groups'; groups: FocusedTestRunnerGroup[] }
  | { kind: 'refuse'; paths: string[]; message: string }
  | { kind: 'invalid-register'; message: string }

/** Route every selected path to exactly one declared runner. */
export function splitFocusedTestPaths(
  runners: readonly FocusedTestRunner[],
  paths: readonly string[],
): FocusedTestRunnerSplit {
  const groups = runners.map((runner) => ({ runner, paths: [] as string[] }))
  const refused: string[] = []
  const ambiguous: string[] = []
  for (const path of paths) {
    const matches = runners
      .map((runner, index) => ({ runner, index }))
      .filter(({ runner }) =>
        runner.patterns
          ? runner.patterns.some((pattern) => new Bun.Glob(pattern).match(path))
          : true,
      )
    if (matches.length > 1) {
      ambiguous.push(path)
      continue
    }
    if (matches.length === 0) {
      refused.push(path)
      continue
    }
    groups[matches[0]!.index]!.paths.push(path)
  }
  if (ambiguous.length) {
    return {
      kind: 'invalid-register',
      message:
        `focusedTests is invalid: paths ${formatFocusedTestPaths(ambiguous)} match two runners; ` +
        'make focusedTests.runners patterns disjoint',
    }
  }
  if (refused.length) {
    return {
      kind: 'refuse',
      paths: refused,
      message:
        `focused tests refused paths ${formatFocusedTestPaths(refused)}; ` +
        'each path must match exactly one runner declared in focusedTests.runners',
    }
  }
  return { kind: 'groups', groups: groups.filter((group) => group.paths.length > 0) }
}

export function parseFocusedTestRequest(value: unknown): FocusedTestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('focused test request must be an object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(request.id)) {
    throw new Error('focused test request id is invalid')
  }
  if (request.affected !== undefined && typeof request.affected !== 'boolean') {
    throw new Error('focused test request affected is invalid')
  }
  return {
    id: request.id,
    paths: parseStringArray(request.paths, 'paths'),
    affected: request.affected === true,
  }
}

export function parseFocusedTestResult(value: unknown): FocusedTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('focused test result must be an object')
  }
  const result = value as Record<string, unknown>
  if (!Number.isInteger(result.exitCode)) throw new Error('focused test result exitCode is invalid')
  if (typeof result.timedOut !== 'boolean') {
    throw new Error('focused test result timedOut is invalid')
  }
  if (typeof result.elapsedMs !== 'number' || !Number.isFinite(result.elapsedMs)) {
    throw new Error('focused test result elapsedMs is invalid')
  }
  if (typeof result.logName !== 'string' || !result.logName || result.logName.includes('/')) {
    throw new Error('focused test result logName is invalid')
  }
  if (typeof result.outputTail !== 'string') {
    throw new Error('focused test result outputTail is invalid')
  }
  return result as FocusedTestResult
}

function beneath(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function normalizedFocusedTestPath(entry: string): string {
  if (!entry || isAbsolute(entry)) {
    throw new Error(`focused test path ${JSON.stringify(entry)} must be relative`)
  }
  if (entry.startsWith('-')) {
    throw new Error(`focused test path ${JSON.stringify(entry)} must not start with '-'`)
  }
  const normalized = normalize(entry)
  if (normalized.split(sep).includes('..')) {
    throw new Error(`focused test path ${JSON.stringify(entry)} contains a parent segment`)
  }
  return normalized
}

export function normalizeFocusedTestPaths(paths: readonly string[]): string[] {
  if (!paths.length) throw new Error('paths must contain at least one project-relative path')
  if (paths.length > FOCUSED_TEST_MAX_PATHS) {
    throw new Error(`paths may contain at most ${FOCUSED_TEST_MAX_PATHS} entries`)
  }
  return paths.map(normalizedFocusedTestPath)
}

/**
 * The shape rules for paths a registered selector chose. FOCUSED_TEST_MAX_PATHS bounds what a
 * worker asks for in one call, not what a project's own selector found, so these paths are exempt
 * from that count; an empty selection is meaningful and passes through.
 */
export function normalizeAffectedTestPaths(paths: readonly string[]): string[] {
  return paths.map(normalizedFocusedTestPath)
}

/**
 * One path's filesystem facts. Paths reach this decision already normalized — a worker's at its
 * call edge, a selector's where its output was parsed — so a fact carries the path itself.
 */
export type FocusedTestPathFact = {
  path: string
  resolvedRoot: string
  resolvedCandidate: string | null
  exists: boolean
}

export function decideFocusedTestPathFacts(facts: readonly FocusedTestPathFact[]): string[] {
  return facts.map(({ path, resolvedRoot, resolvedCandidate, exists }) => {
    if (!exists || !resolvedCandidate) {
      throw new Error(`focused test path ${JSON.stringify(path)} does not exist`)
    }
    if (!beneath(resolvedRoot, resolvedCandidate)) {
      throw new Error(`focused test path ${JSON.stringify(path)} resolves outside the run worktree`)
    }
    return path
  })
}

export function focusedTestInvocation(
  runner: FocusedTestRunner,
  paths: readonly string[],
  worktree: string,
): { command: string; argv: string[] } {
  return {
    command:
      isAbsolute(runner.command) || !runner.command.includes('/')
        ? runner.command
        : resolve(worktree, runner.command),
    argv: [...runner.args, ...paths],
  }
}

export function boundedFocusedTestOutputTail(value: string): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= FOCUSED_TEST_OUTPUT_TAIL_BYTES) return value
  return bytes.subarray(bytes.byteLength - FOCUSED_TEST_OUTPUT_TAIL_BYTES).toString()
}

/** What one call's paths amount to: the paths to run, or the refusal they earn. */
export type FocusedTestPathDecision =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'refuse'; message: string }

/** What the adapter observed of the project's selector, when the call asked for affected tests. */
export type FocusedTestSelectorOutcome =
  | { kind: 'closed' }
  | { kind: 'not-declared' }
  | { kind: 'ill-declared'; problem: string }
  | { kind: 'no-base' }
  | {
      kind: 'failed'
      exitCode: number
      timedOut: boolean
      overflowed: boolean
      stderrTail: string
    }
  | { kind: 'printed'; stdout: string }

export type AffectedSelection =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'none' }
  | { kind: 'refuse'; message: string }

/** Combine every runner's affected selector result without returning typed paths through stdout. */
export function decideAffectedSelection(
  outcomes: readonly { runner: FocusedTestRunner; outcome: FocusedTestSelectorOutcome }[],
): AffectedSelection {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const { outcome } of outcomes) {
    const selected = decideSelectorTestPaths(outcome)
    if (selected.kind === 'refuse') return selected
    for (const path of selected.paths) {
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
  }
  return paths.length ? { kind: 'paths', paths } : { kind: 'none' }
}

export type FocusedTestSelectionInput =
  | { affected: false; requestedPaths: readonly string[] }
  | {
      affected: true
      requestedPaths: readonly string[]
      selector: AffectedSelection | FocusedTestSelectorOutcome
    }

/**
 * What one run_tests call runs: the paths, nothing to run, or the refusal it earns. `paths` is the
 * union of what the call asked for and what the selector chose; `selectorPaths` names the selector's
 * own part of it, so a path that cannot run is refused against the side that named it.
 */
export type FocusedTestSelection =
  | { kind: 'run'; paths: string[]; selectorPaths: string[]; note: string | null }
  | { kind: 'none'; message: string }
  | { kind: 'refuse'; message: string }

const FOCUSED_TEST_NOTHING_AFFECTED =
  'No test file in this project imports what this run changed, so nothing was affected and no focused test ran.'

/**
 * Whether one call runs the focused test runner and on which paths. The worker's own paths keep
 * FOCUSED_TEST_MAX_PATHS and the worker's paths come first; the selector's paths are exempt from
 * that count and are appended deduplicated. A selection of nothing at all is a completed result
 * that says so rather than a runner invocation.
 */
export function decideFocusedTestSelection(input: FocusedTestSelectionInput): FocusedTestSelection {
  const requested = decideRequestedTestPaths(input.affected, input.requestedPaths)
  if (requested.kind === 'refuse') return requested
  const selected = input.affected
    ? input.selector.kind === 'none'
      ? { kind: 'paths' as const, paths: [] }
      : input.selector.kind === 'paths' || input.selector.kind === 'refuse'
        ? input.selector
        : decideSelectorTestPaths(input.selector)
    : { kind: 'paths' as const, paths: [] }
  if (selected.kind === 'refuse') return selected
  const union = unionFocusedTestPaths(requested.paths, selected.paths)
  if (!union.paths.length) return { kind: 'none', message: FOCUSED_TEST_NOTHING_AFFECTED }
  return {
    kind: 'run',
    paths: union.paths,
    selectorPaths: union.added,
    note: input.affected ? affectedSelectionNote(union.paths.length, selected.paths.length) : null,
  }
}

/**
 * What a selector's own run amounts to. A selector the broker stopped for its own timeout or
 * overflow reports that cause even though stopping it looked like a cancellation; only a selector
 * that did not fail while its supervising run closed reports the close. Stopping a selector for its
 * own reason never becomes the close's message.
 */
export function decideFocusedTestSelectorOutcome(input: {
  cancelled: boolean
  outcome: FocusedTestSelectorOutcome
}): FocusedTestSelectorOutcome {
  if (input.outcome.kind === 'failed' && (input.outcome.timedOut || input.outcome.overflowed)) {
    return input.outcome
  }
  return input.cancelled ? { kind: 'closed' } : input.outcome
}

/**
 * The refusal a path the project's own selector printed earns when it cannot be run. The message
 * names the register key that produced the path, because the condition is that declaration and not
 * a broker failure.
 */
export function affectedSelectorPathRefusal(message: string): string {
  return `the affected-test selector (focusedTests.affected) printed a path run_tests cannot run: ${message}`
}

function decideRequestedTestPaths(
  affected: boolean,
  paths: readonly string[],
): FocusedTestPathDecision {
  if (!paths.length) {
    return affected
      ? { kind: 'paths', paths: [] }
      : { kind: 'refuse', message: 'paths must contain at least one project-relative path' }
  }
  try {
    return { kind: 'paths', paths: normalizeFocusedTestPaths(paths) }
  } catch (error) {
    return { kind: 'refuse', message: refusalText(error) }
  }
}

function decideSelectorTestPaths(selector: FocusedTestSelectorOutcome): FocusedTestPathDecision {
  if (selector.kind === 'closed') {
    return { kind: 'refuse', message: FOCUSED_TEST_CLOSE_REASON }
  }
  if (selector.kind === 'not-declared') {
    return { kind: 'refuse', message: affectedSelectorRegisterMessage() }
  }
  if (selector.kind === 'ill-declared') {
    return { kind: 'refuse', message: affectedSelectorProblemMessage(selector.problem) }
  }
  if (selector.kind === 'no-base') {
    return {
      kind: 'refuse',
      message:
        'This run records no base commit, so focusedTests.affected has nothing to select the ' +
        'tests of what this run changed against.',
    }
  }
  if (selector.kind === 'failed')
    return { kind: 'refuse', message: selectorFailureMessage(selector) }
  return parseAffectedSelectorOutput(selector.stdout)
}

/**
 * The paths a selector's stdout names: one project-relative test path per line, blank lines
 * ignored. An empty selection is a valid answer; a line that is not a project-relative path is not.
 */
export function parseAffectedSelectorOutput(output: string): FocusedTestPathDecision {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  try {
    return { kind: 'paths', paths: normalizeAffectedTestPaths(lines) }
  } catch (error) {
    return {
      kind: 'refuse',
      message: `the affected-test selector printed output run_tests cannot read: ${refusalText(error)}`,
    }
  }
}

function selectorFailureMessage(selector: {
  exitCode: number
  timedOut: boolean
  overflowed: boolean
  stderrTail: string
}): string {
  const tail = selector.stderrTail.trim() || '(no output)'
  if (selector.timedOut) {
    return `the affected-test selector timed out; its stderr tail:\n${tail}`
  }
  if (selector.overflowed) {
    return (
      `the affected-test selector printed more than ${FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES} bytes, ` +
      `so its selection was refused; its stderr tail:\n${tail}`
    )
  }
  return `the affected-test selector exited ${selector.exitCode}; its stderr tail:\n${tail}`
}

function unionFocusedTestPaths(
  requested: readonly string[],
  selected: readonly string[],
): { paths: string[]; added: string[] } {
  const paths = [...requested]
  const seen = new Set(requested)
  const added: string[] = []
  for (const path of selected) {
    if (seen.has(path)) continue
    seen.add(path)
    added.push(path)
    paths.push(path)
  }
  return { paths, added }
}

function affectedSelectionNote(ran: number, selected: number): string {
  const plural = (count: number) => (count === 1 ? 'path' : 'paths')
  return (
    `focusedTests.affected selected ${selected} test ${plural(selected)}; ` +
    `running ${ran} ${plural(ran)} in total.`
  )
}

function refusalText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
