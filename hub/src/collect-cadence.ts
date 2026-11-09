/**
 * Two cadences, because the legs cost very different amounts.
 *
 * Transcripts and runs are local reads over a short window and take under a
 * second; the trackers are four remote round trips and take seconds, so they
 * run rarely. Git is cheap but only changes on commit, so it rides with them.
 */
export const FAST_MS = 20_000
export const SLOW_MS = 5 * 60_000
