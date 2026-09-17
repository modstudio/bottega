import { expect, test } from 'bun:test'
import {
  type FixtureQuestion,
  fixtureIntervalsWithoutRuns,
  fixtureQuestionsWithoutRuns,
} from './fixture-question-reclaim.ts'

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

test('listed fixture interval with explicit unknown answer is selected (mutation: skip the unknown-run check)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:9103' }],
      new Map([[9103, { id: 9103, status: 'unknown', unknown: true }]]),
    ),
  ).toEqual([{ id: 1, source: 'orch', ref: 'orch:9103' }])
})

test('listed fixture interval with no answer is kept (mutation: treat a missing answer as unknown)', () => {
  expect(
    fixtureIntervalsWithoutRuns([{ id: 1, source: 'orch', ref: 'orch:9103' }], new Map()),
  ).toEqual([])
})

test('listed fixture interval with known run is kept (mutation: select every listed ref)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:9103' }],
      new Map([[9103, { id: 9103, status: 'ok' }]]),
    ),
  ).toEqual([])
})

test('unlisted interval with unknown run is kept (mutation: select any unknown orch interval)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:2072' }],
      new Map([[2072, { id: 2072, status: 'unknown', unknown: true }]]),
    ),
  ).toEqual([])
})

test('turn ref looks up the turn id not the root (mutation: look up parsed.root for turn refs)', () => {
  const interval = { id: 1, source: 'orch' as const, ref: 'orch:9301:turn:9302' }
  expect(
    fixtureIntervalsWithoutRuns(
      [interval],
      new Map([
        [9301, { id: 9301, status: 'ok' }],
        [9302, { id: 9302, status: 'unknown', unknown: true }],
      ]),
    ),
  ).toEqual([interval])
  expect(
    fixtureIntervalsWithoutRuns(
      [interval],
      new Map([
        [9301, { id: 9301, status: 'unknown', unknown: true }],
        [9302, { id: 9302, status: 'ok' }],
      ]),
    ),
  ).toEqual([])
})
