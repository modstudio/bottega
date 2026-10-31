import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type QuestionScratchLocation,
  referencedQuestionScratchPaths,
  renderRunQuestionText,
  runQuestionGroupFooter,
} from './question-display.ts'

const RUN_DIRECTORY = '/state/orchestrator/runs/run-this'
const DISPLAY_PATHS = {
  scratch: `${RUN_DIRECTORY}/scratch`,
  artifacts: `${RUN_DIRECTORY}/artifacts`,
  droppedManifest: `${RUN_DIRECTORY}/artifacts/dropped.json`,
}
const ANSWER_COMMAND = `${PLATFORM_SLUG} question answer root-id`

type DisplayCase =
  | { name: string; footer: { numbers: number[] }; expected: string }
  | {
      name: string
      text: string
      locations?: Array<[string, QuestionScratchLocation]>
      expected: string
    }
  | { name: string; list: string; expected: string[] }

describe('run-question display', () => {
  test.each<DisplayCase>([
    {
      name: 'footer for one open question',
      footer: { numbers: [7] },
      expected: `rule on it:  ${ANSWER_COMMAND} "<ruling>"`,
    },
    {
      name: 'footer for two open questions',
      footer: { numbers: [7, 9] },
      expected: `rule on them in ONE command:  ${ANSWER_COMMAND} --q7 "<ruling>" --q9 "<ruling>"`,
    },
    {
      name: 'footer for three open questions',
      footer: { numbers: [7, 9, 12] },
      expected:
        `rule on them in ONE command:  ${ANSWER_COMMAND} ` +
        '--q7 "<ruling>" --q9 "<ruling>" --q12 "<ruling>"',
    },
    {
      name: 'absolute live scratch reference stays unchanged',
      text: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
      locations: [['report.json', 'scratch']],
      expected: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
    },
    {
      name: 'environment live scratch reference resolves to the absolute scratch path',
      text: 'Read $BOTTEGA_SCRATCH/report.json now',
      locations: [['report.json', 'scratch']],
      expected: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
    },
    {
      name: 'retained scratch reference moves to artifacts',
      text: `Read ${RUN_DIRECTORY}/scratch/nested/report.json now`,
      locations: [['nested/report.json', 'artifacts']],
      expected: `Read ${RUN_DIRECTORY}/artifacts/nested/report.json now`,
    },
    {
      name: 'dropped scratch reference keeps its path and names the manifest',
      text: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
      locations: [['report.json', 'gone']],
      expected:
        `Read ${RUN_DIRECTORY}/scratch/report.json ` +
        `(not retained at turn end; see ${RUN_DIRECTORY}/artifacts/dropped.json) now`,
    },
    {
      name: 'environment scratch reference resolves to the artifacts path',
      text: 'Read $BOTTEGA_SCRATCH/report.json now',
      locations: [['report.json', 'artifacts']],
      expected: `Read ${RUN_DIRECTORY}/artifacts/report.json now`,
    },
    {
      name: 'unknown absolute scratch reference stays unchanged',
      text: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
      locations: [['report.json', 'unknown']],
      expected: `Read ${RUN_DIRECTORY}/scratch/report.json now`,
    },
    {
      name: 'unknown environment scratch reference stays unchanged',
      text: 'Read $BOTTEGA_SCRATCH/report.json now',
      locations: [['report.json', 'unknown']],
      expected: 'Read $BOTTEGA_SCRATCH/report.json now',
    },
    {
      name: 'another run scratch reference stays unchanged',
      text: 'Read /state/orchestrator/runs/run-other/scratch/report.json now',
      expected: 'Read /state/orchestrator/runs/run-other/scratch/report.json now',
    },
    {
      name: 'text without a scratch reference stays unchanged',
      text: 'Should the command accept both forms?',
      expected: 'Should the command accept both forms?',
    },
    {
      name: 'reference lister returns unique relative paths in appearance order',
      list:
        `First ${RUN_DIRECTORY}/scratch/a.json, then $BOTTEGA_SCRATCH/nested/b.txt, ` +
        `then ${RUN_DIRECTORY}/scratch/a.json.`,
      expected: ['a.json', 'nested/b.txt'],
    },
  ])('$name', (entry) => {
    if ('footer' in entry) {
      expect(runQuestionGroupFooter('root-id', entry.footer.numbers)).toBe(entry.expected)
      return
    }
    if ('list' in entry) {
      expect(referencedQuestionScratchPaths(entry.list, DISPLAY_PATHS.scratch)).toEqual(
        entry.expected,
      )
      return
    }
    expect(renderRunQuestionText(entry.text, DISPLAY_PATHS, new Map(entry.locations ?? []))).toBe(
      entry.expected,
    )
  })
})
