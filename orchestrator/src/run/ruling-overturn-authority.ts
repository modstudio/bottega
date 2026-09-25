// concern: ruling-overturn
/** Decides overturn refusals and authority without touching process or database state. */

export type OverturnRulingDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; code: 'unanswered' | 'already-overturned' }

export function overturnRulingDecision(input: {
  answeredAt: string | null
  overturnedAt: string | null
}): OverturnRulingDecision {
  if (input.answeredAt === null) return { kind: 'refuse', code: 'unanswered' }
  if (input.overturnedAt !== null) return { kind: 'refuse', code: 'already-overturned' }
  return { kind: 'allow' }
}
