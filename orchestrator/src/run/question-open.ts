// concern: question-open
/** Defines the one durable predicate for an open question. */

export const questionOpenSql = (alias: string): string =>
  `${alias}.answered_at IS NULL AND ${alias}.closed_at IS NULL`
