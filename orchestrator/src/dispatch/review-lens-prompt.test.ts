import { describe, expect, test } from 'bun:test'
import {
  MAX_EARLIER_ROUND_REJECTIONS,
  renderEarlierRoundRejections,
  reviewLensPrompt,
} from './review-lens-prompt.ts'
import type { ReviewFindingMemory } from './review-memory.ts'

const lens = { question: 'Does the change actually hold?', excludes: 'taste and style nits' }
const noEarlierRejections = { project: 'fixture', branch: null, rows: [] }

describe('reviewLensPrompt', () => {
  test('no-prompt mutation: a lens question is the prompt', () => {
    expect(
      reviewLensPrompt({
        lens,
        mechanicallyEnforced: [],
        earlierRejections: noEarlierRejections,
        supplied: '',
      }),
    ).toBe(`QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`)
  })

  test('supplied-prompt mutation: lens text first, supplied text after', () => {
    const supplied = 'focus on the new parser'
    const prompt = reviewLensPrompt({
      lens,
      mechanicallyEnforced: [],
      earlierRejections: noEarlierRejections,
      supplied,
    })
    expect(prompt.startsWith(`QUESTION\n${lens.question}`)).toBe(true)
    expect(prompt.indexOf(lens.question)).toBeLessThan(prompt.indexOf(supplied))
    expect(prompt.endsWith(supplied)).toBe(true)
    expect(prompt).not.toBe(supplied)
  })

  test('no-lens mutation: review-lens without a lens is still refused as empty', () => {
    expect(() =>
      reviewLensPrompt({
        lens: null,
        mechanicallyEnforced: [],
        earlierRejections: noEarlierRejections,
        supplied: '',
      }),
    ).toThrow('empty prompt')
    expect(() =>
      reviewLensPrompt({
        lens: null,
        mechanicallyEnforced: [],
        earlierRejections: noEarlierRejections,
        supplied: '  \n',
      }),
    ).toThrow('empty prompt')
  })

  test('renders enforced categories between exclusions and supplied text', () => {
    const supplied = 'focus on the new parser'
    const prompt = reviewLensPrompt({
      lens,
      mechanicallyEnforced: [
        { title: 'Formatting', tool: 'biome format' },
        { title: 'Secrets', tool: 'gitleaks' },
      ],
      earlierRejections: noEarlierRejections,
      supplied,
    })

    expect(prompt).toBe(
      `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}\n\n` +
        'ENFORCED BY TOOL IN THIS PROJECT\n' +
        'Formatting: biome format\n' +
        'Secrets: gitleaks\n\n' +
        'A blocking tool refuses these before a change can land here. Do not report a finding whose whole substance is one of them. A defect in the same area that the tool cannot judge is still yours to report.\n\n' +
        supplied,
    )
  })
})

type MemoryRow = ReviewFindingMemory['rows'][number]

function finding(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    project: 'fixture',
    branch: 'DEV-1373',
    reviewRecordId: '01990000-0000-7000-8000-000000000010',
    reviewNumber: 10,
    completedAt: '2026-10-15T12:00:00Z',
    ordinal: 1,
    disposition: 'rejected',
    location: 'src/example.ts:4',
    evidence: 'The first line\ncontinues on the second.',
    rejectionCategory: 'incorrect',
    triageReason: 'The API already guarantees this.',
    lens: 'correctness',
    reviewedCommit: 'abc123',
    ...overrides,
  }
}

test('carries only current same-branch completed rejections and reports the cap', () => {
  const older = Array.from({ length: MAX_EARLIER_ROUND_REJECTIONS }, (_, index) =>
    finding({
      reviewRecordId: `01990000-0000-7000-8000-${String(100 - index).padStart(12, '0')}`,
      reviewNumber: 100 - index,
      completedAt: `2026-10-${String(14 - Math.floor(index / 2)).padStart(2, '0')}T12:00:00Z`,
      ordinal: index + 2,
      location: `src/older-${index}.ts:1`,
      triageReason: null,
    }),
  )
  const rendered = renderEarlierRoundRejections({
    project: 'fixture',
    branch: 'DEV-1373',
    rows: [
      ...older,
      finding(),
      finding({ disposition: 'accepted', location: 'src/accepted.ts:1' }),
      finding({
        disposition: 'accepted',
        location: 'src/amended.ts:1',
        triageReason: 'Amended from rejected to accepted.',
      }),
      finding({ branch: 'DEV-other', location: 'src/foreign.ts:1' }),
      finding({ completedAt: null, location: 'src/incomplete.ts:1' }),
    ],
  })

  expect(rendered).toContain('RULED IN EARLIER ROUNDS')
  expect(rendered).toContain(
    'src/example.ts:4 — The first line continues on the second. [rejected: incorrect; reason: The API already guarantees this.; lens: correctness; reviewed commit: abc123]',
  )
  expect(rendered).not.toContain('src/accepted.ts')
  expect(rendered).not.toContain('src/amended.ts')
  expect(rendered).not.toContain('src/foreign.ts')
  expect(rendered).not.toContain('src/incomplete.ts')
  expect(rendered).toContain('1 earlier rejected finding(s) omitted by the carry cap.')
})

test('carry cap breaks equal completion timestamps by review number, not UUID arithmetic', () => {
  const rows = Array.from({ length: MAX_EARLIER_ROUND_REJECTIONS + 2 }, (_, index) =>
    finding({
      reviewRecordId: `01990000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
      reviewNumber: index + 1,
      completedAt: '2026-10-15T12:00:00Z',
      location: `src/review-${index + 1}.ts:1`,
    }),
  )
  const rendered = renderEarlierRoundRejections({
    project: 'fixture',
    branch: 'DEV-1373',
    rows,
  })

  expect(rendered).toContain('src/review-22.ts:1')
  expect(rendered).toContain('src/review-3.ts:1')
  expect(rendered).not.toContain('src/review-2.ts:1 —')
  expect(rendered).not.toContain('src/review-1.ts:1 —')
})

test('carries rejected findings from an inherited review branch', () => {
  const rendered = renderEarlierRoundRejections({
    project: 'fixture',
    branch: 'DEV-1373-fix',
    branchLineage: ['DEV-1373-fix', 'DEV-1373-reviewed'],
    rows: [
      finding({ branch: 'DEV-1373-reviewed', location: 'src/inherited.ts:4' }),
      finding({ branch: 'DEV-1373-unrelated', location: 'src/unrelated.ts:4' }),
    ],
  })

  expect(rendered).toContain('src/inherited.ts:4')
  expect(rendered).not.toContain('src/unrelated.ts:4')
})

test('places earlier rulings after exclusions and tool enforcement', () => {
  const prompt = reviewLensPrompt({
    lens: { question: 'Is it correct?', excludes: 'Style.' },
    mechanicallyEnforced: [{ title: 'Types', tool: 'bun run typecheck' }],
    earlierRejections: {
      project: 'fixture',
      branch: 'DEV-1373',
      rows: [finding()],
    },
    supplied: 'Inspect this change.',
  })

  expect(prompt.indexOf('EXCLUDES')).toBeLessThan(prompt.indexOf('ENFORCED BY TOOL'))
  expect(prompt.indexOf('ENFORCED BY TOOL')).toBeLessThan(prompt.indexOf('RULED IN EARLIER ROUNDS'))
  expect(prompt.indexOf('RULED IN EARLIER ROUNDS')).toBeLessThan(
    prompt.indexOf('Inspect this change.'),
  )
  expect(prompt).toContain('unless the code at that location changed since the commit shown')
})
