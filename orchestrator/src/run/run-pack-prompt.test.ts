import { describe, expect, test } from 'bun:test'
import { reviewLensPrompt } from '../dispatch/review-lens-prompt.ts'
import { setLens, setProfile } from '../lens/lenses.ts'
import {
  bindReviewInstructions,
  checksReviewedCommit,
  initialDispatchPrompt,
  operatorKnowledgeSection,
  TASK_TEXT_MAX_BYTES,
  taskTextSection,
} from './run-pack-prompt.ts'

describe('operator knowledge prompt section', () => {
  test('a canon-only pack yields a prompt containing the canon', () => {
    const section = operatorKnowledgeSection({ markdown: 'CANON-ONLY-CONTENT' })
    expect(section).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
    expect(section).toContain('CANON-ONLY-CONTENT')
  })

  test('an empty pack yields no prompt section', () => {
    expect(operatorKnowledgeSection({ markdown: '' })).toBe('')
  })

  test.each([true, false])(
    'places task rulings and task text before the spec when writesJob is %s',
    (writesJob) => {
      const prompt = initialDispatchPrompt({
        writesJob,
        preamble: 'PREAMBLE',
        infrastructure: '',
        operatorKnowledge: 'WHAT THE OPERATOR WANTS YOU TO KNOW\n\nCANON',
        taskRulings: 'RULINGS ALREADY MADE ON THIS TASK\n\nRULING',
        taskText: 'TASK TEXT: DEV-1 — Carry text\n\nTask body',
        spec: 'WORK',
      })
      expect(prompt.indexOf('CANON')).toBeLessThan(prompt.indexOf('RULINGS ALREADY'))
      expect(prompt.indexOf('RULINGS ALREADY')).toBeLessThan(prompt.indexOf('TASK TEXT: DEV-1'))
      expect(prompt.indexOf('TASK TEXT: DEV-1')).toBeLessThan(prompt.indexOf('THE SPEC'))
    },
  )
})

describe('task text prompt section', () => {
  test('renders carried task text and comments', () => {
    expect(
      taskTextSection({
        task: {
          available: true,
          recordId: 'record',
          key: 'DEV-1',
          title: 'Carry text',
          body: 'Task body',
          comments: ['First ruling', 'Second ruling'],
        },
        key: 'DEV-1',
        project: 'fixture',
        getTool: 'get-task-tool',
        hub: true,
      }),
    ).toBe(
      'TASK TEXT: DEV-1 — Carry text\n\nTask body\n\nTask comment: First ruling\n\nTask comment: Second ruling',
    )
  })

  test('renders an unavailable read as one line', () => {
    const section = taskTextSection({
      task: { available: false, reason: 'server unavailable' },
      key: 'DEV-2',
      project: 'fixture',
      getTool: 'get-task-tool',
      hub: true,
    })
    expect(section).toBe('TASK TEXT: DEV-2 could not be read: server unavailable')
    expect(section).not.toContain('\n')
  })

  test('bounds a carried read and names the tracker get tool after truncation', () => {
    const section = taskTextSection({
      task: {
        available: true,
        recordId: null,
        key: 'STAR-3',
        title: 'Large task',
        body: 'é'.repeat(TASK_TEXT_MAX_BYTES),
        comments: [],
      },
      key: 'STAR-3',
      project: 'starship',
      getTool: 'get-task-tool',
      hub: false,
    })
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(TASK_TEXT_MAX_BYTES)
    expect(section).toEndWith('Task text was truncated; read the full task with get-task-tool.')
  })
})

describe('review instructions', () => {
  test('checks repository-backed findings but not inline findings', () => {
    expect(checksReviewedCommit(true, true)).toBe(true)
    expect(checksReviewedCommit(true, false)).toBe(false)
  })

  test('binds an implicit repository review artifact without a branch', () => {
    const prompt = bindReviewInstructions({
      prompt: 'Review this change.',
      findings: true,
      firstTurn: true,
      reviewTarget: null,
      readsRepo: true,
      checkoutCommit: 'caf69b0d11111111111111111111111111111111',
      coverageBase: 'b0583f6522222222222222222222222222222222',
      lens: undefined,
      repo: null,
    })

    expect(prompt).toContain('REVIEW ARTIFACT')
    expect(prompt).toContain('HEAD: caf69b0d11111111111111111111111111111111')
    expect(prompt).toContain('Base: b0583f6522222222222222222222222222222222')
    expect(prompt).not.toContain('Branch:')
  })

  test('a known lens question appears once in the bound reviewer prompt', async () => {
    const question = 'Does this exact question appear once?'
    await setLens(
      {
        id: 'question-once',
        title: 'Question once',
        question,
        excludes: 'Other questions.',
        slots: JSON.stringify({
          type: 'object',
          properties: { looks_for: { type: 'string' } },
          additionalProperties: false,
        }),
        enabled: true,
        requiresExecution: false,
        reason: 'prompt fixture',
      },
      '',
    )
    await setProfile({
      lensId: 'question-once',
      axis: 'framework',
      name: 'default',
      body: '{"looks_for":"Duplication."}',
      enabled: true,
      reason: 'prompt fixture',
    })
    const initial = reviewLensPrompt({
      lens: { question, excludes: 'Other questions.' },
      mechanicallyEnforced: [],
      earlierRejections: { project: 'fixture', branch: null, branchLineage: [], rows: [] },
      supplied: 'Inspect the change.',
    })
    const prompt = bindReviewInstructions({
      prompt: initial,
      findings: true,
      firstTurn: true,
      reviewTarget: null,
      readsRepo: false,
      checkoutCommit: null,
      coverageBase: null,
      lens: 'question-once',
      repo: null,
    })

    expect(prompt.split(question)).toHaveLength(2)
    expect(prompt).toContain('LOOKS FOR\nDuplication.')
  })
})
