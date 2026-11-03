// concern: typed-question-registry
/** Declares stable typed questions and the probability at which callers act. */

export type NoulQuestion = {
  id: string
  version: number
  type: 'noul'
  instructions: string
  threshold: number
}

export type ChoiceQuestion = {
  id: string
  version: number
  type: 'choice'
  instructions: string
  criteria: Readonly<Record<string, string>>
  threshold: number
}

export type TypedQuestion = NoulQuestion | ChoiceQuestion

export const SPEC_UNSETTLED_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.85,
  instructions:
    'This is a task specification handed to a coding agent that must stop and ask rather than decide anything itself. Judge whether the spec leaves at least one choice between reasonable options that it does not settle, so the agent will have to ask.',
} as const satisfies NoulQuestion
