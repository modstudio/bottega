import { describe, expect, test } from 'bun:test'
import { vendorFigures } from './format'
import {
  matchesRunSearch,
  runSearchText,
  type SearchableLiveRun,
  type SearchableRun,
} from './run-search'
import { PROJECT_FALLBACK } from './project'

const completed: SearchableRun = {
  id: 42,
  agent: 'codex',
  job: 'review-lens',
  task: 'DEV-259',
  project: 'workshop',
  at: '2026-09-06T14:30:00.000Z',
  engaged: '4m 12s',
  running: false,
  status: 'ok',
  delivery: 'partial',
  quality: 'mixed',
  tokens: 12_300,
  costUsd: 1.25,
  probe: false,
  lens: 'craft',
}

test('vendor figures remain separate currencies', () => {
  expect(
    vendorFigures([
      { agent: 'grok', tokens: 1_200_000 },
      { agent: 'codex', tokens: 340_000 },
    ]),
  ).toBe('grok 1.2M · codex 340K')
})

const live: SearchableLiveRun = {
  id: 43,
  agent: 'grok',
  job: 'implement',
  repo: 'starship',
  elapsedMs: 92_000,
  prompt_head: 'Fix the collection search so every visible value can find its own row.',
}

describe('runs collection search', () => {
  test('completed rows include every rendered text field', () => {
    for (const query of [
      'workshop',
      'DEV-259',
      'codex',
      'review-lens',
      'craft',
      '4m 12s',
      'partial',
      'mixed',
      '12.3K',
      '$1.25',
      'Sep 6',
      '10:30 am',
    ])
      expect(matchesRunSearch(completed, query)).toBe(true)

    expect(
      matchesRunSearch({ ...completed, delivery: null, quality: null, status: 'failed' }, 'failed'),
    ).toBe(true)
    expect(
      matchesRunSearch({ ...completed, delivery: null, quality: null, probe: true }, 'probe'),
    ).toBe(true)
    expect(
      matchesRunSearch(
        { ...completed, evidence_excluded: 'voided with orch score --void' },
        'Not routing evidence',
      ),
    ).toBe(true)
  })

  test('a voided unscored run is not found by Unscored and is found by the exclusion', () => {
    const voidedUnscored = {
      ...completed,
      delivery: null,
      quality: null,
      evidence_excluded: 'voided with orch score --void',
    }
    expect(matchesRunSearch(voidedUnscored, 'Unscored')).toBe(false)
    expect(matchesRunSearch(voidedUnscored, 'Not routing evidence')).toBe(true)
  })

  test('a voided full/right still matches its stored verdict and the exclusion', () => {
    const voidedFull = {
      ...completed,
      delivery: 'full',
      quality: 'right',
      evidence_excluded: 'voided with orch score --void',
    }
    expect(matchesRunSearch(voidedFull, 'full')).toBe(true)
    expect(matchesRunSearch(voidedFull, 'right')).toBe(true)
    expect(matchesRunSearch(voidedFull, 'Not routing evidence')).toBe(true)
  })

  test('live rows include every rendered text field, but not truncated prompt text', () => {
    for (const query of ['grok', 'implement', 'starship', '1m 32s', 'collection search']) {
      expect(matchesRunSearch(live, query)).toBe(true)
    }
    expect(runSearchText({ ...live, prompt_head: `${'x'.repeat(90)}hidden` })).not.toContain(
      'hidden',
    )
  })

  test('rows without a project are found by the fallback ProjectMark renders', () => {
    expect(matchesRunSearch({ ...completed, project: null }, PROJECT_FALLBACK)).toBe(true)
    expect(matchesRunSearch({ ...live, repo: null }, PROJECT_FALLBACK)).toBe(true)
  })
})
