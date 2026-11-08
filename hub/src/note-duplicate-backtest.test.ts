import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { newRecordId } from '../../shared/record-id.ts'
import { db } from './db.ts'
import {
  NOTE_DUPLICATE_HOLDOUT_SHARE,
  noteDuplicateHoldout,
  noteDuplicateSweep,
  reconstructNotePairState,
} from './note-duplicate-backtest.ts'

const metricRow = (probability: number, label: boolean) => ({
  probability,
  label,
  error: null,
  latencyMs: 1,
  inputTokens: 0,
})

test('holdout assignment is the deterministic first digest byte split', () => {
  const subject = '018f0000-0000-7000-8000-000000000000:0123456789abcdef'
  const expected =
    createHash('sha256').update(subject).digest()[0]! < NOTE_DUPLICATE_HOLDOUT_SHARE * 256
  expect(noteDuplicateHoldout(subject)).toBe(expected)
  expect(noteDuplicateHoldout(subject)).toBe(expected)
})

test('reconstruction counts a missing existing note as unreadable state', () => {
  expect(reconstructNotePairState(db(), `${newRecordId()}:0123456789abcdef`)).toBeNull()
})

test('threshold sweep computes precision and recall on a fixed set', () => {
  const row = noteDuplicateSweep([
    metricRow(0.9, true),
    metricRow(0.8, false),
    metricRow(0.4, true),
  ]).find((candidate) => candidate.threshold === 0.8)!
  expect(row.precision).toBe(0.5)
  expect(row.recall).toBe(0.5)
  expect(row.warnedRate).toBe(2 / 3)
})
