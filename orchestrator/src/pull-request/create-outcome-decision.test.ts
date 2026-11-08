import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideCreateOutcome } from './create-outcome-decision.ts'

const dirty = {
  number: 42,
  url: 'https://github.example/pulls/42',
  mergeability: {
    kind: 'report' as const,
    conflict: true,
    message:
      'https://github.example/pulls/42 conflicts with main: rebase it on the landing branch before merging',
  },
}

const input = {
  existing: null,
  createResult: { stdout: 'https://github.example/pulls/42', failure: null },
  created: null,
  branch: 'DEV-2189-create-outcome',
  platformSlug: PLATFORM_SLUG,
}

describe('pull-request create outcome', () => {
  test('an existing dirty pull request is reported without running create and finalizes its number', () => {
    expect(decideCreateOutcome({ ...input, existing: dirty, createResult: null })).toEqual({
      throwMessage: null,
      output:
        'pull request already exists for DEV-2189-create-outcome: https://github.example/pulls/42; gh pr create was not run\nhttps://github.example/pulls/42 conflicts with main: rebase it on the landing branch before merging',
      finalizePullRequestNumber: 42,
    })
  })

  test('a failed create is refused', () => {
    expect(
      decideCreateOutcome({
        ...input,
        createResult: { stdout: '', failure: 'authentication required' },
      }),
    ).toEqual({
      throwMessage: 'gh pr create failed: authentication required',
      output: '',
      finalizePullRequestNumber: null,
    })
  })

  test('a successful unresolved create reports the pending remedy', () => {
    expect(decideCreateOutcome(input)).toEqual({
      throwMessage: null,
      output: `https://github.example/pulls/42\ngh pr view DEV-2189-create-outcome could not resolve the created pull request; mergeability was not checked and the triage intent remains pending; rerun ${PLATFORM_SLUG} pr create to record it`,
      finalizePullRequestNumber: null,
    })
  })

  test('a successful create resolving dirty reports the conflict and finalizes its number', () => {
    expect(decideCreateOutcome({ ...input, created: dirty })).toEqual({
      throwMessage: null,
      output:
        'https://github.example/pulls/42\nhttps://github.example/pulls/42 conflicts with main: rebase it on the landing branch before merging',
      finalizePullRequestNumber: 42,
    })
  })
})
