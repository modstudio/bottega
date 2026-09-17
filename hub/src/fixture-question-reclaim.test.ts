import { expect, test } from 'bun:test'
import { type FixtureQuestion, fixtureQuestionsWithoutRuns } from './fixture-question-reclaim.ts'

test('fixture question selection removes only documented sessions whose run is absent', () => {
  const row = (
    question_id: number,
    session_id: string,
    run_ref = `orch:${question_id}`,
  ): FixtureQuestion => ({
    question_id,
    session_id,
    run_ref,
    root_ref: run_ref,
    task_key: 'DEV-3000',
  })
  expect(
    fixtureQuestionsWithoutRuns(
      [
        row(1, 'sess-a'),
        row(2, 'sess-b'),
        row(3, 'sess-old'),
        row(4, 'sess-probe'),
        row(5, 'sess-real'),
        row(6, 'sess-a', 'orch:live'),
      ],
      new Set(['orch:live']),
    ),
  ).toEqual([row(1, 'sess-a'), row(2, 'sess-b'), row(3, 'sess-old'), row(4, 'sess-probe')])
})
