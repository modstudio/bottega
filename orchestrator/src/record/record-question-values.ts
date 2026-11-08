// concern: record-question-values
/** Maps typed worker-question evidence into the hosted question columns. */

type Payload = Record<string, unknown>

const text = (value: unknown): string | null => (value == null ? null : String(value))
const number = (value: unknown): number | null => (value == null ? null : Number(value))

export function typedQuestionRecordValues(row: Payload) {
  return {
    kind: text(row.kind),
    typedOptions: row.typedOptions,
    criteria: row.criteria,
    levels: row.levels,
    answerValue: text(row.answerValue),
    answeredByKind: text(row.answeredByKind),
    jevPick: text(row.jevPick),
    jevConfidence: number(row.jevConfidence),
    jevProbabilities: row.jevProbabilities,
    jevModel: text(row.jevModel),
    jevInputTokens: number(row.jevInputTokens),
    jevError: text(row.jevError),
    jevAgreed: number(row.jevAgreed),
    jevQuestionVersion: number(row.jevQuestionVersion),
    jevFits: number(row.jevFits),
    jevOrderFlipped: number(row.jevOrderFlipped),
  }
}
