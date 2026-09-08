/**
 * Why a run failed, and whether a human needs to know.
 *
 * Two kinds of failure need a person: the plan is out of tokens, and the login
 * has gone stale. Both stop an agent working until someone acts, and neither
 * announces itself - without this a quota-exhausted agent keeps being routed to
 * and keeps failing, silently, until the failures are noticed by accident.
 *
 * Grok's HTTP 402 / exhausted-balance response is observed in real runs. The
 * remaining strings are deliberately generic shapes. That is why `other` is
 * reported rather than swallowed: a real vendor failure that classifies as
 * `other` is the signal to add its actual wording here.
 */
/** Runtime vocabulary as well as a type: reporting must show zeroes for new kinds. */
export const FAILURE_KINDS = [
  'quota', 'auth',
  /**
   * The vendor will not serve this account for the product. Neither waiting nor
   * re-authenticating fixes it; an administrator has to grant the entitlement.
   */
  'entitlement',
  'unreachable', 'timeout', 'denied', 'content_refusal',
  'interrupted',
  /**
   * The vendor exhausted its reply budget or stopped mid-generation before
   * emitting a result, whatever caused it to stop.
   */
  'truncated',
  /** The worker changed a registered checkout outside its disposable worktree. */
  'escaped',
  /** Orch could not verify a watched checkout's before/after status. */
  'confinement_unverified',
  /** Sandbox Runtime denied a read the job needed. */
  'sandbox_denied',
  /** A strict MCP run could not prove a successful tool call before launch. */
  'mcp-unverified',
  /**
   * ORCH's own fault: a bad schema, a missing flag, a precondition it should
   * have checked before spending a run. Set at the point in the code that knows
   * it is the harness at fault, plus the vendor's exact invalid-schema message
   * as a last defence when its strict validator learns a constraint before us.
   */
  'harness',
  /** The agent satisfied the reply schema but violated its behavioural contract. */
  'contract',
  /** A clean review reply that does not establish it reviewed the dispatched change. */
  'unevidenced',
  'abandoned',
  'other',
] as const
export type FailureKind = typeof FAILURE_KINDS[number]

/** Remove volatile values while retaining the wording that identifies one failure shape. */
export function clusterErrorText(value: string | null | undefined): string {
  if (!value?.trim()) return ''
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:file:\/\/)?(?:~\/|\/?(?:Users|private|tmp|var|opt|home)\/)[^\s'"`,;)]+/gi, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:req(?:uest)?[-_]id[-_:=]?|req_)[a-z0-9_-]{6,}\b/gi, '<id>')
    .replace(/\b(task|branch)\s+(?=[a-z0-9._\/-]*[a-z])(?:[a-z][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\d[a-z0-9._-]*\b/gi, '$1 <id>')
    .replace(/\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/gi, '<id>')
    .replace(/\b(run|session|request|call|pid|id)[- _:#=]+(?=[a-z0-9_-]*[a-z])[a-z0-9_-]*\d[a-z0-9_-]*\b/gi, '$1 <id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const PATTERNS: [FailureKind, RegExp][] = [
  /**
   * Exit codes observed in run.exit_code, grouped by failure_kind and agent on
   * 2026-09-02. Vendor documentation names none of these behaviours; these are
   * the database's facts. A dash means no such run had been observed.
   *
   * | vendor | external SIGTERM | external SIGKILL | own timeout |
   * |--------|------------------|------------------|-------------|
   * | codex  | 143 (5)          | -                | 143 (2)     |
   * | grok   | 143 (19)         | -                | -           |
   * | agy    | -                | -                | 1 (1)       |
   * | qwen   | -                | -                | -           |
   *
   * External signals are `interrupted`; an own timeout is `timeout`. The
   * counts come from querying run.exit_code by failure_kind and agent. Grok's
   * changelog separately says older headless builds exited when the agent
   * asked for input, so an undocumented exit alone must not be over-read.
   */
  /**
   * Somebody killed the process tree. Not the agent's doing, and not ours.
   *
   * `exit 143, empty output` is produced by exactly ONE branch of run.ts - the
   * final else, reached only when `timedOut` is false - so by construction this
   * is never our own timer, which sets its own message and its own kind. 143 is
   * 128+15, SIGTERM; 130 and 137 are the SIGINT and SIGKILL of the same event.
   *
   * The cause is named in cli.ts beside --detach: a foreground `orch do` that
   * outlives the calling harness's command timeout has its whole process group
   * killed, run.ts's signal handler forwards SIGTERM to the child, and the
   * child dies having written nothing. Sixteen grok review-lens runs in this
   * database are that, fourteen of them stopped dead on the 600.000s mark while
   * grok's own timeout is 1500s.
   *
   * Anchored whole-string rather than loose, because it is a message this
   * codebase writes, not one a vendor prints. A reply that merely mentions an
   * exit code must not be swallowed.
   */
  ['interrupted', /^exit (?:130|137|143), empty output$/],
  // Codex should never reach the vendor with a schema OpenAI strict mode will
  // reject: agents.ts normalizes and validates it before launch. Keep the
  // vendor's last line of defence classified as our harness fault, never as
  // scoreable evidence about the model.
  ['harness', /Invalid schema for response_format/i],
  // The plan is out. Distinct from `auth` because waiting fixes it.
  ['quota', /\b(402|429|quota|usage limit|rate.?limit|too many requests|out of (?:credit|tokens)|insufficient (?:credit|quota|balance)|balance (?:exhausted|depleted)|exceeded your|plan limit|monthly limit|upgrade your plan)\b/i],
  // Licensing text can also tell the user to sign in again, so entitlement must
  // win before `auth`. Match the licensing vocabulary, never a bare error code.
  ['entitlement', /\b(have a valid licen[cs]e|not licen[cs]ed|request a licen[cs]e)\b/i],
  // The login is stale. Waiting does not fix it; re-authenticating does.
  ['auth', /\b(401|403|unauthori[sz]ed|forbidden|not (?:logged in|authenticated)|invalid (?:api )?key|expired token|please (?:log|sign) in|re-?authenticate)\b/i],
  /**
   * Nothing answered. The endpoint is not there at all.
   *
   * Kept apart from every other kind because it is the only one that says
   * NOTHING ABOUT THE AGENT. A quota failure is a fact about the plan, a denied
   * permission a fact about the harness, a wrong answer a fact about the model —
   * but a box that is switched off is a fact about the room. Folding it into the
   * mean lets an unplugged machine slowly teach the router that the local model
   * is bad at the one job it is measurably best at, which is what happened:
   * two runs during eleven hours of a powered-down local host were recorded as
   * verdicts against `qwen-local` on `file-question`.
   *
   * Deliberately narrower than it could be. `connection reset` stays under
   * `timeout` where it has always been: a peer that resets did answer first, and
   * reclassifying it on no evidence would be trading one guess for another.
   */
  ['unreachable', /\b(connection error|connection refused|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|no route to host|could ?n[o']?t connect|unable to connect|failed to connect|network is unreachable|host is down)\b/i],
  ['timeout', /\b(timeout|timed out|deadline exceeded|ETIMEDOUT|connection reset)\b/i],
  // The vendor declined the prompt itself. This is distinct from `denied`,
  // where the headless harness could not grant a tool permission: a content
  // refusal is a fact about vendor policy and the prompt's shape, and would
  // happen on any machine. The exact wording was observed from Codex on three
  // defensive reviews of guards, hooks, permission boundaries and sandboxes.
  ['content_refusal', /\bcontent was flagged for possible cybersecurity risk\b/i],
  // Headless cannot answer a permission prompt, so the tool call is auto-denied.
  //
  // A bare `approval` used to be one of these alternatives, and it matched the
  // wrong thing on nearly every Codex failure: Codex prints `approval: never` in
  // the banner it echoes before it says anything, and errorTail keeps that
  // banner. Run 243 — a local-endpoint protocol error, `Unexpected message
  // role` — was stored as `denied` on that basis. Only the phrasings that mean a
  // permission was actually refused belong here.
  ['denied', /\b(permission (?:that|was) .*denied|auto-denied|requir(?:e|es|ed) the "?\w+"? permission|approval (?:denied|required|rejected))\b/i],
]

const VENDOR_TERMINATION_MARKERS = [
  '[API Error: terminated]',
]

/**
 * A marker must be the whole trailing line. Reviews discuss API errors in
 * ordinary prose, and matching that vocabulary mid-answer would discard a
 * result that was actually delivered.
 */
export function hasVendorTerminationMarker(text: string): boolean {
  const trailingLine = text.trimEnd().split('\n').at(-1)?.trim()
  return VENDOR_TERMINATION_MARKERS.some((marker) => trailingLine === marker)
}

/**
 * Replies that are the vendor reporting a failure, not the agent answering.
 *
 * A CLI that fails inside its own agentic loop still exits 0 and still prints
 * something, so `exitCode === 0 && output` called it a success and stored the
 * error as the answer. Run 279 is the case: 57 bytes reading
 * `[API Error: Model stream ended with empty response text.]`, recorded `ok`
 * after 409s and 325k vendor tokens, and left for a person to notice.
 *
 * Anchored at the start and kept to literal vendor prefixes. A reply that
 * merely discusses an API error — which a review of this very code would — must
 * not be thrown away, so nothing here matches mid-text.
 */
const NON_ANSWER = [
  /^\[API Error:/i,           // Qwen Code / Gemini CLI lineage
  /^\[Error:/i,
  /^Error:\s*timeout waiting for response/i,
]

export function isNonAnswer(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  const first = t.split('\n', 1)[0]
  try {
    const event = JSON.parse(first)
    if (event?.type === 'system' && event?.subtype === 'init') return true
  } catch { /* ordinary prose is not a transcript */ }
  return NON_ANSWER.some((re) => re.test(t))
}

/**
 * Exit codes that mean SOMETHING KILLED THE PROCESS, not that it failed.
 *
 * 143 is 128+15 (SIGTERM), 130 is SIGINT, 137 is SIGKILL. Read from the exit
 * code rather than from the message because the message is whatever the vendor
 * happened to print, and codex prints a banner and echoes the prompt to stderr
 * — so a harness kill of a codex run arrived as several screens of its own
 * input and was classified `other`, charging the agent for a process group
 * somebody else killed. Every such run in this database was being counted
 * against codex.
 */
const SIGNAL_EXITS = new Set([130, 137, 143])

export function classify(
  error: string | null | undefined,
  /**
   * The child's exit code, when the caller knows it.
   *
   * Decisive where it is a signal death, and consulted BEFORE the text: the
   * text is the vendor's, the exit code is the operating system's. A caller
   * that does not know passes nothing and gets the old text-only behaviour.
   */
  exitCode?: number | null,
  /** Whether OUR timer fired. Our own timeout is a timeout, not an interruption. */
  timedOut = false,
  /** Recorded run sandbox. Only srt denials are sandbox routing evidence. */
  sandbox?: 'host' | 'srt' | null,
): FailureKind {
  if (exitCode != null && SIGNAL_EXITS.has(exitCode)) {
    // OUR timer kills with the same signal as a harness does, so the exit code
    // alone cannot tell them apart — only the caller knows which fired. Ours is
    // a fact about the agent (it ran out of time); a harness kill is a fact
    // about the room, and only the second is excluded from evidence.
    return timedOut ? 'timeout' : 'interrupted'
  }
  if (!error) return 'other'
  if (sandbox === 'srt' &&
      /(?:permission denied|operation not permitted|sandbox(?:-exec)?[^\n]*(?:deny|denied))/i.test(error) &&
      /(?:^|[\s:'"])(?:\/[^\s:'"]+|~\/[^\s:'"]+)/m.test(error)) {
    return 'sandbox_denied'
  }
  for (const [kind, re] of PATTERNS) if (re.test(error)) return kind
  return 'other'
}

/** Failures a person has to act on: nothing downstream can route around them. */
export const NEEDS_HUMAN: FailureKind[] = [
  'quota', 'auth', 'unreachable', 'escaped', 'confinement_unverified',
]

/**
 * What to call each of those when telling somebody, and what they can do.
 *
 * A ternary covered two kinds and would have silently called a powered-down
 * local host an authentication problem the moment a third arrived. A table has to be
 * extended to compile.
 */
export const NEEDS_HUMAN_TITLE: Record<string, (agent: string) => string> = {
  quota: (a) => `${a} is out of quota`,
  auth: (a) => `${a} needs re-authenticating`,
  unreachable: (a) => `${a}'s endpoint is unreachable`,
  escaped: (a) => `outside change observed during ${a} run`,
  confinement_unverified: (a) => `confinement could not be verified during ${a} run`,
}

/**
 * Kinds that put an agent in the corner for an hour.
 *
 * NOT the same list as NEEDS_HUMAN, and the difference is the whole point: a
 * cooldown is for a condition that CANNOT BE OBSERVED WITHOUT SPENDING A RUN.
 * Quota, stale auth and missing entitlement announce themselves only by failing,
 * so the only way to stop paying for the discovery is to stop asking for an hour.
 *
 * Reachability is the opposite. It is measured directly, before every routing
 * decision, for the price of one HTTP call to a socket on this machine — so a
 * cooldown adds no information and costs the entire recovery window. With
 * `unreachable` in this list a box that had been woken and was demonstrably
 * serving again stayed out of routing for the rest of the hour, which defeats
 * the point of waking it at all.
 */
export const COOLS_DOWN: FailureKind[] = ['quota', 'auth', 'entitlement']

/** Failures where another vendor should receive the same prompt immediately. */
export const FAILS_OVER: FailureKind[] = [
  'quota', 'auth', 'entitlement', 'content_refusal', 'contract', 'unevidenced',
]

/**
 * Kinds that must never count as evidence about an agent.
 *
 * Separate from NEEDS_HUMAN, which is about who can fix it. Quota and auth
 * failures describe whether the vendor will serve this account right now, not
 * whether the agent can do the work. An unreachable endpoint is likewise
 * neither the agent's doing nor its record. A content refusal describes vendor
 * policy for a prompt class, not the agent's competence at the job.
 *
 * An interrupted run is the same fact about the room. It cost grok its standing
 * on the job it is best at: on review-lens grok is stored at 76 ok against 14
 * `other` and 4 stale - 81%, behind codex's 93% - and every one of those
 * eighteen is a harness kill. Counting only what grok was actually allowed to
 * finish, it is 76 for 76. The router had been reading an artefact of how `orch
 * do` was invoked as a fact about the model, which is the identical mistake
 * `unreachable` was carved out to stop.
 */
export const NOT_EVIDENCE: FailureKind[] = [
  'quota', 'auth', 'entitlement', 'unreachable', 'content_refusal', 'interrupted', 'truncated', 'escaped',
  'confinement_unverified', 'sandbox_denied', 'mcp-unverified', 'harness', 'abandoned',
]

/**
 * Raise a macOS banner. Detached and never awaited: a notification that could
 * delay or fail a run would be worse than no notification.
 */
export function notify(title: string, message: string): void {
  try {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 200)
    Bun.spawn(
      ['osascript', '-e',
       `display notification "${esc(message)}" with title "orch" subtitle "${esc(title)}"`],
      { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' },
    ).unref()
  } catch { /* a missing osascript must not fail a run */ }
}

/**
 * Blockers an agent volunteered in prose, recognised so they can be counted.
 *
 * Read-only jobs — review-lens, understand, craft — carry no return contract,
 * so a worker with something to report has nowhere structured to put it. They
 * report anyway, in the body of the answer: "Docker access was denied at
 * /Users/…/docker.sock, so PHPUnit could not run", "PHP is unavailable on the
 * host", "the installed dependencies lack the @rolldown/binding-darwin-arm64
 * native binding". Four such runs in one session, none of them countable.
 *
 * DELIBERATELY CONSERVATIVE. A false positive here is worse than a miss: it
 * would put a blocker on a run that had none, and the whole value of the table
 * is that a count of forty means something. Each pattern is quoted from an
 * actual reported blocker rather than imagined, and anything not matched is
 * simply not detected — the structured `blockers` field is the reliable path,
 * and this is the net under the jobs that have no such field.
 */
export type Detected = { kind: string; what: string; why: string }

/**
 * Phrases in which an agent says IT could not do something.
 *
 * The generic patterns below need this and the specific ones do not, because
 * the generic ones match a review's FINDINGS as readily as its complaints. The
 * first backfill proved it: `ECONNREFUSED` matched a lens reporting that a
 * script names the wrong recovery command, and `permission denied` matched one
 * reasoning about an EPERM branch in somebody's error handling. Neither agent
 * was blocked by anything; both were doing their job well.
 *
 * A blocker is the agent talking about ITSELF, so the test is whether the same
 * line says it could not proceed.
 */
const INABILITY = /\b(could ?n'?o?t|cannot|can't|unable to|failed to|was denied|prevented|blocked from)\b/i

/**
 * `needsInability` marks the patterns that are only a blocker when the agent
 * says so. A denied Docker socket names itself; a bare "permission denied"
 * could be anything the agent happened to read.
 */
const BLOCKER_PATTERNS: [string, RegExp, boolean?][] = [
  // `docker` must appear within a few words, which is what keeps this specific
  // enough to need no inability phrase. The verbs are widened because workers
  // describe the same refusal several ways — "access was denied", "access
  // failed", "could not access" — and each spelling was counting as its own
  // problem, which is the opposite of what a recurrence table is for.
  // It still requires the same line to say the worker was unable to proceed;
  // otherwise a quoted Docker error would be recorded as a detected fact.
  ['docker-denied', /docker[^.\n]{0,40}(access[^.\n]{0,12}(denied|failed)|socket[^.\n]{0,30}denied|permission denied|could ?n[o']?t (be )?(reach|access|connect))/i, true],
  ['docker-unavailable', /(cannot connect to the docker daemon|docker daemon is not running)/i, true],
  ['runtime-missing', /\b(php|python3?|ruby|go|java)\b[^.\n]{0,30}\b(is (not available|unavailable)|not (found|installed)|unavailable on the host)/i],
  ['binding-missing', /(lack|missing|could not (find|load))[^.\n]{0,40}native binding/i],
  ['command-not-found', /\b(command not found|: not found)\b/i, true],
  ['permission-denied', /\bpermission denied\b/i, true],
  ['network-refused', /\b(ECONNREFUSED|connection refused)\b/i, true],
]

export function detectBlockers(output: string): Detected[] {
  if (!output) return []
  const found = new Map<string, Detected>()
  for (const line of output.split('\n')) {
    const t = line.trim()
    // A long line is prose about something else more often than it is a report;
    // the real ones are short statements of what could not be done.
    if (!t || t.length > 400) continue
    for (const [kind, re, needsInability] of BLOCKER_PATTERNS) {
      if (!re.test(t)) continue
      if (needsInability && !INABILITY.test(t)) continue
      // First mention wins: an agent that says it twice has one blocker.
      if (!found.has(kind)) {
        found.set(kind, { kind, what: kind.replace(/-/g, ' '), why: t.slice(0, 300) })
      }
    }
  }
  return [...found.values()]
}
