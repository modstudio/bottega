// concern: question-order
/** Orders questions by when they were asked, because numbers repeat across record spaces. */

type Ordered = { asked_at?: unknown; number?: unknown }

export function compareQuestionsByAsk(a: Ordered, b: Ordered): number {
  const left = String(a.asked_at ?? '')
  const right = String(b.asked_at ?? '')
  if (left !== right) return left < right ? -1 : 1
  return Number(a.number) - Number(b.number)
}
