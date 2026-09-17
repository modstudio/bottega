// concern: score
/**
 * Knows delivery, quality, fidelity, weighing, and judgeability. Must not know database state, worktrees, runs, routing, or transports.
 */
export type Delivery = 'none' | 'partial' | 'full'
export type Quality = 'wrong' | 'mixed' | 'right'
/** Did it build what it was asked to build, or something it decided on instead? */
export type Fidelity = 'drifted' | 'partial' | 'faithful'

/**
 * What each cell of the matrix is worth to the router.
 *
 * Read down the rows: a run that never delivered is NEGATIVE, not merely zero,
 * because it is a different kind of failure from a wrong answer. A wrong answer
 * means the agent engaged with the job and got it wrong — it stays a reasonable
 * candidate that happens to be weaker. Nothing arriving means a plumbing or
 * capability mismatch, and that should actively push routing away rather than
 * merely fail to pull it closer, or an agent that CANNOT do a job ranks level
 * with one that does it badly.
 *
 * The three cells the old vocabulary could express keep their exact old values,
 * so migrating changed no agent's standing:
 *
 *     good     -> full/right    1
 *     partial  -> full/mixed    0.5
 *     bad      -> full/wrong    0
 *     unusable -> none         -0.5
 *
 * The partial-delivery row is new, and it is the row that was missing. Run 264
 * lives there: it answered correctly but never fetched the step body it was
 * told to follow, so the answer was right as far as it went and stopped early.
 * Under one axis that was `partial`, the same score as an answer that arrived
 * whole and was half wrong.
 *
 * Deliberately coarse. Three levels an axis is what a person can apply the same
 * way twice, months apart, which matters more than resolution when the whole
 * corpus is 1,425 judgements (`orch stats`, measured 2026-09-06) and five
 * decide a route.
 */
export const WEIGHT: Record<Delivery, Record<Quality, number> | number> = {
  none: -0.5,
  partial: { wrong: -0.25, mixed: 0.25, right: 0.5 },
  full: { wrong: 0, mixed: 0.5, right: 1 },
}

/**
 * What FIDELITY costs when it is judged at all.
 *
 * A penalty rather than a third dimension of the matrix, and the shape is the
 * argument. Delivery and quality are genuinely two questions about one event —
 * did an answer arrive, and was it right — and the matrix exists because their
 * combinations mean different things. Fidelity is not a third such question; it
 * is a discount on an answer that is already good. Correct, working, tested
 * code that solves a different problem is not "half right", it is right about
 * the wrong thing, and the honest encoding is full marks minus what the drift
 * cost.
 *
 * Half a judgement for total drift, matched to one quality step, because that
 * is what it is worth: an implementation that solved the wrong problem is about
 * as useful as one that solved the right problem badly, and both leave the
 * architect with rework rather than with nothing.
 *
 * ESCALATING IS NOT DRIFT. A worker that stopped and asked, then built what it
 * was told, is `faithful` and pays nothing — that promise is made explicitly in
 * the preamble the worker reads, and it has to hold here or asking would cost
 * something after all and nobody would ask.
 */
export const FIDELITY_PENALTY: Record<Fidelity, number> = {
  faithful: 0,
  partial: -0.25,
  drifted: -0.5,
}

/**
 * What one judgement is worth. Null quality is only legal with delivery 'none'.
 *
 * Fidelity is optional and absent for every read-only job, so the two-axis
 * arithmetic is untouched by its introduction: an existing score with no
 * fidelity weighs exactly what it always did, and no agent's standing moved
 * when the column was added.
 */
export function weigh(
  delivery: Delivery,
  quality: Quality | null,
  fidelity: Fidelity | null = null,
): number {
  const row = WEIGHT[delivery]
  const base = typeof row === 'number' ? row : row[quality ?? 'wrong']
  // An unknown level is not a zero penalty. Reading it as "no penalty" would
  // quietly flatter a run nobody judged.
  const pen = fidelity ? FIDELITY_PENALTY[fidelity] : 0
  if (fidelity && pen === undefined) {
    throw new Error(`unknown fidelity "${fidelity}": expected ${FIDELITY.join(' | ')}`)
  }
  /**
   * NOTHING ARRIVING IS THE FLOOR, and the penalty must not dig under it.
   *
   * Unclamped, `partial/wrong/drifted` weighs -0.75 — worse than `none`, which
   * is -0.5. That inverts the rule this matrix is built on: no answer is
   * negative because the agent cannot do the job here, while a wrong answer is
   * merely weak evidence that it engaged. An agent that delivered something
   * unusable would rank BELOW one that delivered nothing at all, and routing
   * would prefer the agent that cannot do the job.
   */
  return Math.max(base + pen, WEIGHT.none as number)
}

/** The best a judgement can be, so a percentage has a denominator. */
/**
 * The vocabulary, in one place.
 *
 * The previous four-verdict scale had `unusable` in the schema and offered it
 * nowhere anyone was scoring — the CLI hint, the run-completion line, the Stop
 * hook and the gate's deny message all said `good|partial|bad`. It was used once
 * in fifty-eight judgements, and a run that returned 57 bytes of vendor error
 * was filed as a quality problem because nothing better was on offer. Exported
 * from here so a level cannot exist that the prompts do not mention.
 */
export const DELIVERY: Delivery[] = ['none', 'partial', 'full']
export const QUALITY: Quality[] = ['wrong', 'mixed', 'right']
export const FIDELITY: Fidelity[] = ['drifted', 'partial', 'faithful']

/**
 * Whether the caller is allowed to judge a run.
 *
 * The rule this enforces is already written down — "only that session can judge
 * it, because only it read the output" — and being written down was not enough.
 * Two sessions scored each other's runs within one hour on 2026-08-31, both by
 * the same route: `orch do` prints a run id only when a long run FINISHES, so
 * during a parallel fan-out you hold outputs with no ids, and "my second block
 * of ids continues my first" is the obvious inference. It is wrong precisely
 * when a concurrent session's runs have interleaved into the gap, which is the
 * case nobody pictures. Neither session had any intent to score another's work.
 *
 * That is why `foreign` is worth blocking rather than merely warning: the error
 * corrects a mistaken belief. Anyone who reads "run 331 was made by session X,
 * you are session Y" and proceeds anyway is no longer making this mistake.
 *
 * The two unknown cases are deliberately NOT blocked. Refusing them would
 * strand every run recorded before session ids existed, and every run scored
 * from a plain shell — punishing missing evidence as though it were evidence of
 * wrongdoing, and pushing people toward the override for honest reasons.
 */
export type Judgeability =
  /** The caller made this run. */
  | { verdict: 'own' }
  /** The run predates session recording, or was made without the env var. */
  | { verdict: 'unattributed' }
  /** The caller has no session id, so ownership cannot be established. */
  | { verdict: 'anonymous'; owner: string }
  /** The run belongs to a different session, and both ids are known. */
  | { verdict: 'foreign'; owner: string }

export function judgeability(runSession: string | null, caller: string | null): Judgeability {
  if (!runSession) return { verdict: 'unattributed' }
  if (!caller) return { verdict: 'anonymous', owner: runSession }
  return runSession === caller ? { verdict: 'own' } : { verdict: 'foreign', owner: runSession }
}
