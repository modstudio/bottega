import { db } from '../database/db.ts'
import { EMPTY_CANON_SHA } from './canon-eval-pack.ts'

export const DEFAULT_EVAL_AGENT = 'codex'

export type FailingDefaultCanonEval = {
  slug: string
  agent: string
}

/** Latest wrong-answer evals for the agent used when `bottega doc canon eval` is unpinned. */
export function failingDefaultCanonEvals(): FailingDefaultCanonEval[] {
  return db()
    .query(
      `SELECT slug, agent
       FROM (
         SELECT slug, agent, pass, canon_sha,
                ROW_NUMBER() OVER (PARTITION BY slug ORDER BY at DESC, record_id DESC) AS recency
         FROM canon_eval
         WHERE agent=?
       )
      WHERE recency=1 AND (pass=0 OR canon_sha=?)
      ORDER BY slug`,
    )
    .all(DEFAULT_EVAL_AGENT, EMPTY_CANON_SHA) as FailingDefaultCanonEval[]
}
