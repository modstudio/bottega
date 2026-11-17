// concern: question-order
/** Orders questions by when they were asked, because numbers repeat across record spaces. */

type Ordered = { asked_at?: unknown; number?: unknown }

export function compareQuestionsByAsk(a: object, b: object): number {
  const first = a as Ordered
  const second = b as Ordered
  const left = String(first.asked_at ?? '')
  const right = String(second.asked_at ?? '')
  if (left !== right) return left < right ? -1 : 1
  return Number(first.number) - Number(second.number)
}
