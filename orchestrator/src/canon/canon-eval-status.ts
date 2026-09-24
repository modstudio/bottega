import { db } from '../database/db.ts'
import { EMPTY_CANON_SHA } from './canon-eval-pack.ts'

export const DEFAULT_EVAL_AGENT = 'codex'

export type FailingDefaultCanonEval = {
  slug: string
  agent: string
}

/** Latest wrong-answer evals for the agent used when `orch canon eval` is unpinned. */
export function failingDefaultCanonEvals(): FailingDefaultCanonEval[] {
  return db()
    .query(
      `SELECT slug, agent
       FROM canon_eval
      WHERE agent=? AND (pass=0 OR canon_sha=?) AND id IN (
        SELECT MAX(id) FROM canon_eval WHERE agent=? GROUP BY slug
      )
      ORDER BY slug`,
    )
    .all(DEFAULT_EVAL_AGENT, EMPTY_CANON_SHA, DEFAULT_EVAL_AGENT) as FailingDefaultCanonEval[]
}
