// concern: typed-question-registry
/** Defines the shape of a typed question; each concern declares its own questions beside the code that asks them. */

export type NoulQuestion = {
  id: string
  version: number
  type: 'noul'
  instructions: string
  threshold: number
  criteria?: Readonly<{ true?: string; false?: string }>
}

export type ChoiceQuestion = {
  id: string
  version: number
  type: 'choice'
  instructions: string
  criteria: Readonly<Record<string, string>>
  threshold: number
}

export type ScoreQuestion = {
  id: string
  version: number
  type: 'score'
  instructions: string
  criteria: readonly string[]
  threshold: number
}

export type TypedQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
