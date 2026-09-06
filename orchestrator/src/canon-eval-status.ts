import { db } from './db.ts'

export const DEFAULT_EVAL_AGENT = 'codex'

export type FailingDefaultCanonEval = {
  slug: string
  agent: string
}

/** Latest wrong-answer evals for the agent used when `orch canon eval` is unpinned. */
export function failingDefaultCanonEvals(): FailingDefaultCanonEval[] {
  return db().query(
    `SELECT slug, agent
       FROM canon_eval
      WHERE agent=? AND pass=0 AND id IN (
        SELECT MAX(id) FROM canon_eval WHERE agent=? GROUP BY slug
      )
      ORDER BY slug`,
  ).all(DEFAULT_EVAL_AGENT, DEFAULT_EVAL_AGENT) as FailingDefaultCanonEval[]
}
