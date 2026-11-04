import type { NoulQuestion } from '../../../shared/typed-question/registry.ts'
import { type CitedFileReader, citedContext } from './cited-context.ts'

/** Asks whether an implementation spec leaves a choice the worker would have to ask about. */
export const SPEC_UNSETTLED_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.85,
  backtestSource: (sources: { specRuns(): Promise<unknown>; findingPairs(): Promise<unknown> }) =>
    sources.specRuns(),
  instructions:
    'This is a task specification handed to a coding agent that must stop and ask rather than decide anything itself. Judge whether the spec leaves at least one choice between reasonable options that it does not settle, so the agent will have to ask.',
} as const satisfies NoulQuestion & {
  backtestSource(sources: {
    specRuns(): Promise<unknown>
    findingPairs(): Promise<unknown>
  }): Promise<unknown>
}

export const SPEC_UNSETTLED_QUESTION_V2 = {
  id: 'spec_unsettled',
  version: 2,
  type: 'noul',
  threshold: 0.85,
  backtestSource: (sources: { specRuns(): Promise<unknown>; findingPairs(): Promise<unknown> }) =>
    sources.specRuns(),
  instructions: `${SPEC_UNSETTLED_QUESTION.instructions} The files the spec cites follow it. A choice is also unsettled when the spec assumes something those files contradict.`,
  contextBuilder: (spec: string, readFile: CitedFileReader) => ({
    spec,
    files: citedContext(spec, readFile),
  }),
} as const satisfies NoulQuestion & {
  backtestSource(sources: {
    specRuns(): Promise<unknown>
    findingPairs(): Promise<unknown>
  }): Promise<unknown>
  contextBuilder(
    spec: string,
    readFile: CitedFileReader,
  ): { spec: string; files: ReturnType<typeof citedContext> }
}
