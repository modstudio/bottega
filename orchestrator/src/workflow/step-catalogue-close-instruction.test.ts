import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type UnsupportedCloseEvidenceFlag,
  unsupportedCloseEvidenceFlags,
} from './step-catalogue.ts'
import type { FloorEntry } from './step-catalogue-definition.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'

const decisionCases: Array<{
  name: string
  floors: FloorEntry[]
  body: string
  expected: UnsupportedCloseEvidenceFlag[]
}> = [
  {
    name: 'task evidence on a recorded-artifact floor',
    floors: ['recorded-artifact'],
    body: 'Close this step with `--task <KEY>`.',
    expected: [{ flag: '--task', acceptingFloors: ['tracker-transition'] }],
  },
  {
    name: 'artifact task evidence on a recorded-artifact floor',
    floors: ['recorded-artifact'],
    body: 'Close this step with `--artifact task:<KEY>`.',
    expected: [],
  },
  {
    name: 'ruling evidence without a ruling floor',
    floors: ['command-exit'],
    body: 'To close the step, pass `--ruling <question id>`.',
    expected: [{ flag: '--ruling', acceptingFloors: ['ruling'] }],
  },
  {
    name: 'a templated floor resolves at composition, so its text is not judged',
    floors: ['{{tracker.waitingReview.floor}}'],
    body: 'Close this step with `--task <KEY>`.',
    expected: [],
  },
  {
    name: 'a flag in a command that does not close the step',
    floors: ['recorded-artifact'],
    body: `Run \`${PLATFORM_SLUG} pr merge --release-required\` after review. Record the result.`,
    expected: [],
  },
]

test.each(decisionCases)('$name', ({ floors, body, expected }) => {
  expect(unsupportedCloseEvidenceFlags(floors, body)).toEqual(expected)
})

test('every authored workflow step names only evidence accepted by its floors', () => {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const store = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  expect(
    store.steps.flatMap((step) =>
      unsupportedCloseEvidenceFlags(step.floor, step.body).map((finding) => ({
        step: step.slug,
        ...finding,
      })),
    ),
  ).toEqual([])
})

test('workflow tree parsing refuses a mismatched authored close instruction with its remedy', () => {
  expect(() =>
    parseWorkflowTree([
      {
        path: '.agents/workflow-steps/write.md',
        body: `---
title: Write
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs: []
---
Close this step with \`--task <KEY>\`.
`,
      },
    ]),
  ).toThrow(
    '.agents/workflow-steps/write.md: close instruction names --task, which none of its declared floors accept; --task is accepted by tracker-transition; change the instruction to an accepted flag, or change the floor',
  )
})
