import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideConditionalAdvance } from './workflow-cursor-transition.ts'
import { expandWorkflowModeSteps } from './workflow-step-sequences.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { normalizeWorkflowYaml, parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

const store: WorkflowTreeStore = {
  sequences: [{ slug: 'quality', title: 'Quality', steps: ['verify'] }],
  steps: [
    {
      slug: 'verify',
      title: 'Verify',
      stage: 'implement',
      floor: ['command-exit'],
      outcomes: ['passed', 'failed'],
      rulingOutcomes: ['failed'],
      reenter: { to: 'prepare', outcome: 'failed' },
      job: null,
      autonomy: 'auto',
      needs: ['docs'],
      body: 'Run the gate.',
    },
  ],
  workflows: [
    {
      slug: 'flow',
      definition: {
        title: 'Ship',
        description: 'Ship the change.',
        defaultPreset: 'autonomous',
        arguments: [
          { name: 'key', required: true, description: 'Task key.' },
          { name: 'branch', required: false, description: 'Existing branch.' },
        ],
        modes: [
          {
            slug: 'default',
            title: 'Ship',
            default: true,
            requires: ['branch'],
            steps: [
              { sequence: 'quality', omit: ['verify'] },
              { step: 'verify', when: { step: 'prepare', outcome: ['ready'] } },
            ],
          },
        ],
      },
    },
  ],
}

describe('normalizeWorkflowYaml', () => {
  test.each([
    ['two-line empty array', 'needs: \n  []', 'needs: []'],
    ['one-line empty array', 'needs: []', 'needs: []'],
    ['two-line empty array under another key', 'arguments: \n  []', 'arguments: []'],
  ])('%s has one stable spelling', (_label, yaml, expected) => {
    expect(normalizeWorkflowYaml(yaml)).toBe(expected)
  })
})

describe('planWorkflowHydration', () => {
  test('writes every production row into an empty tree and the resulting tree is stable', () => {
    const first = planWorkflowHydration({ store, tree: [] })
    expect(first.writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-sequences/quality.md',
      '.agents/workflow-steps/verify.md',
      '.agents/workflows/flow.md',
    ])
    expect(planWorkflowHydration({ store, tree: first.writes })).toEqual({
      writes: [],
      deletes: [],
    })
    expect(parseWorkflowTree(first.writes)).toEqual(store)
  })

  test('deletes a tree file whose slug is absent from production', () => {
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: '.agents/workflow-steps/obsolete.md', body: 'old' }],
      }).deletes,
    ).toEqual(['.agents/workflow-steps/obsolete.md'])
  })

  test('reports drift in a changed sequence file', () => {
    const rendered = planWorkflowHydration({ store, tree: [] }).writes
    const changed = rendered.map((file) =>
      file.path === '.agents/workflow-sequences/quality.md'
        ? { ...file, body: file.body.replace('title: Quality', 'title: Changed') }
        : file,
    )
    expect(planWorkflowHydration({ store, tree: changed }).writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-sequences/quality.md',
    ])
  })

  test('README.md in steps is neither parsed nor deleted and is refused at collection', () => {
    const tree = [{ path: '.agents/workflow-steps/README.md', body: 'notes\n' }]
    expect(parseWorkflowTree(tree)).toEqual({ steps: [], sequences: [], workflows: [] })
    expect(planWorkflowHydration({ store, tree }).deletes).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'orch-workflow-tree-readme-'))
    try {
      mkdirSync(join(root, '.agents', 'workflow-steps'), { recursive: true })
      writeFileSync(join(root, '.agents', 'workflow-steps', 'README.md'), 'notes\n')
      expect(() => collectWorkflowTree(root)).toThrow(
        `refusing ${join(root, '.agents', 'workflow-steps', 'README.md')}: not a workflow tree file`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('tracked plan-task design signoff', () => {
  const tracked = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  const planTask = tracked.workflows.find(({ slug }) => slug === 'plan-task')!.definition
  const designSignoff = tracked.steps.find(({ slug }) => slug === 'design-signoff')!

  test('operator revision reenters design', () => {
    expect(designSignoff.outcomes).toEqual(['approved', 'revise'])
    expect(designSignoff.reenter).toEqual({ to: 'design', outcome: 'revise' })
  })

  test.each(['feature', 'fix'])('%s requires operator signoff for schema or names', (slug) => {
    const mode = planTask.modes.find((candidate) => candidate.slug === slug)!
    const steps = expandWorkflowModeSteps(mode.steps, tracked.sequences)
    const designOrdinal = steps.findIndex((step) => step.slug === 'design')
    const signoffOrdinal = steps.findIndex((step) => step.slug === 'design-signoff')
    const decomposeOrdinal = steps.findIndex((step) => step.slug === 'decompose')

    expect(steps.findIndex((step) => step.slug === 'prior-art')).toBeLessThan(designOrdinal)
    expect(decideConditionalAdvance(steps, [], designOrdinal, 'schema-or-names').ordinal).toBe(
      signoffOrdinal,
    )
    expect(decideConditionalAdvance(steps, [], designOrdinal, 'neither').ordinal).toBe(
      decomposeOrdinal,
    )
    expect(designSignoff.operatorRuling).toBe(true)
  })

  test('the fix path skips prior art, design, and signoff for a new symptom', () => {
    const mode = planTask.modes.find((candidate) => candidate.slug === 'fix')!
    const steps = expandWorkflowModeSteps(mode.steps, tracked.sequences)
    const recurrenceOrdinal = steps.findIndex((step) => step.slug === 'recurrence')

    expect(decideConditionalAdvance(steps, [], recurrenceOrdinal, 'new-symptom')).toMatchObject({
      ordinal: steps.findIndex((step) => step.slug === 'decompose'),
      skipped: [
        { step: { slug: 'prior-art' } },
        { step: { slug: 'design' } },
        { step: { slug: 'design-signoff' } },
      ],
    })
  })
})
