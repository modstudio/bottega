import type { NoulQuestion } from '../../../shared/typed-question/registry.ts'

/** Asks whether two independent review findings identify the same defect. */
export const FINDING_DUPLICATE_QUESTION = {
  id: 'finding_duplicate',
  version: 1,
  type: 'noul',
  threshold: 0.8,
  backtestSource: (sources: { specRuns(): Promise<unknown>; findingPairs(): Promise<unknown> }) =>
    sources.findingPairs(),
  instructions:
    'These are two findings from independent code reviews of the same change. Judge whether they report the same underlying defect, so that one fix resolves both.',
} as const satisfies NoulQuestion & {
  backtestSource(sources: {
    specRuns(): Promise<unknown>
    findingPairs(): Promise<unknown>
  }): Promise<unknown>
}
