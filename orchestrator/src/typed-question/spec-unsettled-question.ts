import type { NoulQuestion } from '../../../shared/typed-question/registry.ts'

/** Asks whether an implementation spec leaves a choice the worker would have to ask about. */
export const SPEC_UNSETTLED_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.85,
  instructions:
    'This is a task specification handed to a coding agent that must stop and ask rather than decide anything itself. Judge whether the spec leaves at least one choice between reasonable options that it does not settle, so the agent will have to ask.',
} as const satisfies NoulQuestion
