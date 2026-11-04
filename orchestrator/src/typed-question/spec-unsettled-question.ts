import type { NoulQuestion } from '../../../shared/typed-question/registry.ts'
import type { BacktestSourceName } from './backtest-source-name.ts'
import { type CitedFileReader, citedContext } from './cited-context.ts'

/** Asks whether an implementation spec leaves a choice the worker would have to ask about. */
export const SPEC_UNSETTLED_QUESTION = {
  id: 'spec_unsettled',
  version: 1,
  type: 'noul',
  threshold: 0.85,
  backtest: 'spec-runs',
  instructions:
    'This is a task specification handed to a coding agent that must stop and ask rather than decide anything itself. Judge whether the spec leaves at least one choice between reasonable options that it does not settle, so the agent will have to ask.',
} as const satisfies NoulQuestion & { backtest: BacktestSourceName }

export const SPEC_UNSETTLED_QUESTION_V2 = {
  id: 'spec_unsettled',
  version: 2,
  type: 'noul',
  threshold: 0.85,
  backtest: 'spec-runs',
  instructions: `${SPEC_UNSETTLED_QUESTION.instructions} The files the spec cites follow it. A choice is also unsettled when the spec assumes something those files contradict.`,
  contextBuilder: (spec: string, readFile: CitedFileReader) => ({
    spec,
    files: citedContext(spec, readFile),
  }),
} as const satisfies NoulQuestion & {
  backtest: BacktestSourceName
  contextBuilder(
    spec: string,
    readFile: CitedFileReader,
  ): { spec: string; files: ReturnType<typeof citedContext> }
}

type SpecQuestion = typeof SPEC_UNSETTLED_QUESTION | typeof SPEC_UNSETTLED_QUESTION_V2

/** The state a spec question is asked with, live and in a backtest: its declared builder, else the spec. */
export function specQuestionState(
  question: SpecQuestion,
  spec: string,
  readFile: CitedFileReader,
): string | Record<string, unknown> {
  return 'contextBuilder' in question ? question.contextBuilder(spec, readFile) : spec
}

/** Answers recorded before spec subjects named their job used this kind; they were all implement. */
const LEGACY_SPEC_SUBJECT_KIND = 'spec'
const SPEC_SUBJECT_KIND_PREFIX = 'spec:'

export function specSubjectKind(job: string): string {
  return `${SPEC_SUBJECT_KIND_PREFIX}${job}`
}

/** The job a spec subject kind names, or null for a kind that is not a spec subject. */
export function specSubjectKindJob(subjectKind: string): string | null {
  if (subjectKind === LEGACY_SPEC_SUBJECT_KIND) return 'implement'
  return subjectKind.startsWith(SPEC_SUBJECT_KIND_PREFIX)
    ? subjectKind.slice(SPEC_SUBJECT_KIND_PREFIX.length)
    : null
}

/** Every recorded kind that names this job, the legacy kind included for implement. */
export function specSubjectKinds(job: string): string[] {
  return job === 'implement'
    ? [specSubjectKind(job), LEGACY_SPEC_SUBJECT_KIND]
    : [specSubjectKind(job)]
}

/**
 * The spec question versions dispatch asks. A version joins only after its backtest beats the
 * versions already here; `SPEC_UNSETTLED_QUESTION` is the one that warns.
 */
export const DISPATCH_SPEC_QUESTIONS: readonly SpecQuestion[] = [SPEC_UNSETTLED_QUESTION]
