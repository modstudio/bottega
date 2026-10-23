// concern: orchestrator
/**
 * The spare-hands lane: pure decisions for scheduled, best-effort background
 * jobs given only to free-tier agents. Nothing on the critical path depends on
 * this lane, so every decision here - which documents qualify, what a run's
 * reply means, and which effects follow it - is a plain function over supplied
 * facts; the runner supplies the facts and the adapters do the I/O.
 */
import { FAILURE_KINDS, type FailureKind } from '../failure/failure.ts'

/**
 * Failure kinds that exhaust the free tier and end a spare night. Only the
 * names live here; the taxonomy in failure.ts owns the list, and a name that
 * leaves the taxonomy fails loudly at import instead of silently going missing.
 */
const SPARE_STOP_FAILURE_KIND_NAMES: readonly FailureKind[] = [
  'daily_quota',
  'quota',
  'billing',
  'timeout',
  'capacity',
]

export const SPARE_STOP_FAILURE_KINDS: readonly FailureKind[] =
  SPARE_STOP_FAILURE_KIND_NAMES.filter((name) =>
    (FAILURE_KINDS as readonly string[]).includes(name),
  )

if (SPARE_STOP_FAILURE_KINDS.length !== SPARE_STOP_FAILURE_KIND_NAMES.length) {
  const known = new Set<string>(FAILURE_KINDS)
  const missing = SPARE_STOP_FAILURE_KIND_NAMES.filter((name) => !known.has(name))
  throw new Error(`spare stop failure kind not in FAILURE_KINDS: ${missing.join(', ')}`)
}

/** A free tier is the only thing spare work may use, and only while enabled. */
export type SpareAgentCandidate = { name: string; billing: string; enabled?: boolean }

export function spareAgentEligible(agent: SpareAgentCandidate): boolean {
  return agent.billing === 'free' && agent.enabled === true
}

/** The first eligible agent in registry order, or none. Spare work never falls over. */
export function pickSpareAgent(agents: readonly SpareAgentCandidate[]): SpareAgentCandidate | null {
  return agents.find(spareAgentEligible) ?? null
}

/**
 * Why the night ended. `window` is the clock, `budget` is a run that exhausted
 * the free tier, `write` is a finding the runner could not record, `start` is a
 * dispatch that named no run the night could wait on, and `empty` is a queue
 * with nothing left. A run still unfinished at the window is `window`, never
 * `budget`: an unfinished run is not a failure.
 */
export type NightStopReason = 'window' | 'budget' | 'write' | 'start' | 'empty'

export type NightStop = { stop: boolean; reason: NightStopReason | null }

/**
 * Whether the night is over. The endings, in the order they can occur: the
 * window closed, a run exhausted the free tier, a finding could not be
 * recorded, or the queue is empty.
 */
export function decideNightStop(input: {
  elapsedMinutes: number
  windowMinutes: number
  pending: number
  lastFailureKind: string | null
  writeFailed?: boolean
}): NightStop {
  if (input.elapsedMinutes >= input.windowMinutes) return { stop: true, reason: 'window' }
  if (
    input.lastFailureKind !== null &&
    SPARE_STOP_FAILURE_KINDS.includes(input.lastFailureKind as FailureKind)
  ) {
    return { stop: true, reason: 'budget' }
  }

  if (input.writeFailed === true) return { stop: true, reason: 'write' }
  if (input.pending <= 0) return { stop: true, reason: 'empty' }
  return { stop: false, reason: null }
}

/** Minutes in a night window, correctly wrapping midnight (22:00 to 05:00 is 420). */
export function spareWindowMinutes(startMinutes: number, stopMinutes: number): number {
  const span = stopMinutes - startMinutes
  return span > 0 ? span : span + 24 * 60
}

/** Parse an `HH:MM` machine-config clock value into minutes of day. */
export function minutesOfDay(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error(`clock value "${value}" is not HH:MM`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw new Error(`clock value "${value}" is not HH:MM`)
  return hours * 60 + minutes
}

/**
 * The local calendar day of a window's start. The night is the operator's
 * local night, not a UTC day that drifts a date behind the clock the window is
 * defined in.
 */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** A document awaiting a drift check, with the check time already resolved. */
type DriftQueueItem = { slug: string; scope: string; kind: string; checkedAtMs: number | null }

/**
 * Least recently checked first. A document never checked has no check time and
 * sorts ahead of every checked one; the rest sort oldest check first. The
 * returned order is the contract; the input is left untouched.
 */
export function orderDocsDriftQueue<T extends { checkedAtMs: number | null }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    if (a.checkedAtMs === null && b.checkedAtMs === null) return 0
    if (a.checkedAtMs === null) return -1
    if (b.checkedAtMs === null) return 1
    return a.checkedAtMs - b.checkedAtMs
  })
}

/** Everything the queue policy needs about one document already gathered. */
export type DriftDocFacts = DriftQueueItem & {
  project: string
  path: string
  visibility: string
  visibilityRepository: string | null
  currentRepository: string | null
}

/**
 * Only a project article on a public repository that is the verified one
 * qualifies. The checked-against commit is an article field, so a working
 * document could never record its check and would head the queue for ever. The
 * free provider may train on its inputs, so the existing training-data
 * eligibility - public visibility with a verified repository - is what admits a
 * document to the queue. Ordered least recently checked first.
 */
export function selectDocsDriftQueue(docs: readonly DriftDocFacts[]): DriftDocFacts[] {
  const eligible = docs.filter(
    (doc) =>
      doc.scope === 'project' &&
      doc.kind === 'article' &&
      doc.visibility === 'public' &&
      Boolean(doc.visibilityRepository) &&
      doc.visibilityRepository === doc.currentRepository,
  )
  return orderDocsDriftQueue(eligible)
}

type NoteAction = 'new' | 'same'

/**
 * A note already filed for this document is a repeat, so it is a sighting;
 * otherwise the first finding is a new note.
 */
function noteActionFor(existingNote: boolean): NoteAction {
  return existingNote ? 'same' : 'new'
}

/**
 * What a drift check concluded. `drift` is a verify-claim verdict of false,
 * `clean` is a verdict of true, and `no-evidence` is anything else: a reply
 * that cannot be trusted, or a verdict of undecidable. Whatever the agent wrote
 * about individual claims stays in the run for a human to read; this decision
 * reads the verdict alone.
 */
export type DriftVerdict = { kind: 'drift' } | { kind: 'clean' } | { kind: 'no-evidence' }

/**
 * Recover the object from a reply, tolerating the fences and prose an agent
 * wraps JSON in. Returns null when nothing parses.
 */
function parseReplyObject(reply: string): unknown {
  const trimmed = reply.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next shape */
    }
  }
  return null
}

/** The verify-claim verdict, or null when the reply does not carry that shape. */
function contractVerdict(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { verdict, provenance } = parsed as Record<string, unknown>
  if (verdict !== 'true' && verdict !== 'false' && verdict !== 'undecidable') return null
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    return null
  }
  if (typeof (provenance as Record<string, unknown>).canon_source !== 'string') return null
  return verdict
}

/**
 * Decide from the verify-claim contract alone: `{"verdict": "true"|"false"|
 * "undecidable", "provenance": {"canon_source": ...}}`. A reply that does not
 * carry that shape is no evidence, and `undecidable` is no evidence too, so
 * only an established verdict advances the queue.
 */
export function decideDriftVerdict(reply: string): DriftVerdict {
  const verdict = contractVerdict(parseReplyObject(reply))
  if (verdict === 'false') return { kind: 'drift' }
  if (verdict === 'true') return { kind: 'clean' }
  return { kind: 'no-evidence' }
}

/** What a completed document's outcome is allowed to write. */
export type DriftEffectPlan = { markChecked: boolean; note: { action: NoteAction } | null }

/**
 * The effects one document's verdict licenses. No evidence changes nothing and
 * leaves the document at the front of the queue; a clean reply records the
 * checked commit and files nothing; drift records the checked commit and files a
 * note, or a sighting when one already exists.
 */
export function planDriftEffects(verdict: DriftVerdict, existingNote: boolean): DriftEffectPlan {
  if (verdict.kind === 'no-evidence') return { markChecked: false, note: null }
  if (verdict.kind === 'clean') return { markChecked: true, note: null }
  return { markChecked: true, note: { action: noteActionFor(existingNote) } }
}

/**
 * The line the night prints for one completed check, or null when there is
 * nothing worth saying. A reply that established nothing wrote nothing, so the
 * document stays at the front of the queue and the night says why.
 */
export function driftOutcomeLine(input: { slug: string; verdict: DriftVerdict }): string | null {
  if (input.verdict.kind !== 'no-evidence') return null
  return `spare: ${input.slug} returned no usable evidence; nothing written`
}

/**
 * The line the night prints for a write it could not make. A finding the runner
 * cannot record is a write failure, and a write failure ends the night.
 */
export function writeFailureLine(input: { slug: string; write: string; detail: string }): string {
  return `spare: ${input.write} for ${input.slug} failed (${input.detail}); stopping the night`
}

/** The opening every drift note for one document shares, so a repeat is found. */
export function driftNoteOpening(slug: string, project: string): string {
  return `docs-drift: ${slug} (${project})`
}

/**
 * The note already filed for this document, matched on the opening of its text
 * rather than a substring anywhere in it, so a finding for one document is
 * never read as another's. The first finding for a document has no opening to
 * match and files a new note.
 */
export function existingDriftNote<T extends { text: string }>(
  notes: readonly T[],
  input: { slug: string; project: string },
): T | null {
  const opening = driftNoteOpening(input.slug, input.project)
  return notes.find((note) => note.text.startsWith(opening)) ?? null
}

/**
 * What the runner may conclude about a waited run. `unfinished` means the run
 * had not reached a terminal state when the wait ended; it is never read as a
 * failure. Only a terminal row is completed or failed.
 */
export type WaitedRunClass = 'completed' | 'failed' | 'unfinished'

export function classifyWaitedRow(input: {
  /**
   * `bottega run wait` exits 2 when the run is still running, 1 when any run
   * failed or was observed dead, and 0 when every run was ok; any other exit
   * means the wait itself did not establish a terminal row.
   */
  waitExitCode: number
  status: string | null
}): WaitedRunClass {
  if (input.waitExitCode !== 0 && input.waitExitCode !== 1) return 'unfinished'
  if (input.status === null || input.status === 'running') return 'unfinished'
  return input.status === 'ok' ? 'completed' : 'failed'
}

/** What one dispatch attempt left the night able to do. */
export type DispatchClass = 'dispatched' | 'capacity' | 'rowless' | 'unidentified'

/**
 * Classify one `run start` from its exit code, whether a labeled row appeared
 * and whether the printed identifier is usable. A refused start with no row is
 * the capacity stop; an unusable identifier stops the night with `start`, never
 * the window; a zero exit that left no row is an anomaly the night reports and
 * carries on from.
 */
export function classifyDispatch(input: {
  exitCode: number
  rowAppeared: boolean
  identifierUsable: boolean
}): DispatchClass {
  if (!input.rowAppeared) return input.exitCode !== 0 ? 'capacity' : 'rowless'
  return input.identifierUsable ? 'dispatched' : 'unidentified'
}

/** One labeled run row, as far as the night summary needs it. */
export type SpareRunRow = { status: string; failureKind: string | null; latencyMs: number | null }

export type NightSummary = {
  attempted: number
  completed: number
  medianDurationMs: number | null
  writeFailures: number
  stopReason: NightStopReason
}

/** Derive the night's record from its labeled run rows and how it stopped. */
export function spareNightSummary(input: {
  runs: readonly SpareRunRow[]
  writeFailures: number
  stopReason: NightStopReason
}): NightSummary {
  const attempted = input.runs.length
  const completed = input.runs.filter((run) => run.status === 'ok').length
  const durations = input.runs
    .map((run) => run.latencyMs)
    .filter((ms): ms is number => typeof ms === 'number')
    .sort((a, b) => a - b)
  const medianDurationMs =
    durations.length === 0
      ? null
      : durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]!
        : Math.round((durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2)
  return {
    attempted,
    completed,
    medianDurationMs,
    writeFailures: input.writeFailures,
    stopReason: input.stopReason,
  }
}

/** The label that names one night's runs, so a night's rows can be read back. */
export function spareNightLabel(job: string, day: string): string {
  return `spare:${job}:${day}`
}

/**
 * The dispatch argv for one spare run. The prompt names the document to fetch,
 * `--agent` pins the spare agent, `--no-failover` forbids falling over to a
 * paid agent, `--no-wait-capacity` keeps a spare run out of capacity waits, and
 * `--porcelain` prints only the run identifier so the runner can wait on it.
 */
export function spareDispatchArgv(input: {
  runJob: string
  prompt: string
  repo: string
  agent: string
  key: string
  label: string
}): string[] {
  return [
    'run',
    'start',
    input.runJob,
    input.prompt,
    '--repo',
    input.repo,
    '--agent',
    input.agent,
    '--no-failover',
    '--no-wait-capacity',
    '--key',
    input.key,
    '--label',
    input.label,
    '--porcelain',
  ]
}

/**
 * The wait argv for one dispatched run, bounded by the night's remaining
 * window. A wait that reaches its timeout leaves the run unfinished, which the
 * runner reads as the window ending, never as a failure.
 */
export function spareWaitArgv(runId: string, timeoutSeconds: number): string[] {
  return ['run', 'wait', runId, '--timeout', String(Math.max(1, Math.floor(timeoutSeconds)))]
}
