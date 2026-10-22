import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { db } from '../database/db.ts'
import type { MetricTranscriptSource } from './metric-collection.ts'
import { collect, metricCalendarDay } from './metric.ts'

function timestampWithLocalDay(iso: string, year: number, month: number, day: number): Date {
  const value = new Date(iso)
  value.getFullYear = () => year
  value.getMonth = () => month - 1
  value.getDate = () => day
  return value
}

describe('metric calendar', () => {
  test('keeps both sides of UTC midnight in the same local day', () => {
    const before = timestampWithLocalDay('2026-09-11T23:59:59Z', 2026, 9, 11)
    const after = timestampWithLocalDay('2026-09-12T00:00:01Z', 2026, 9, 11)
    expect(metricCalendarDay(before)).toBe('2026-09-11')
    expect(metricCalendarDay(after)).toBe('2026-09-11')
  })

  test('changes buckets at local midnight', () => {
    const before = timestampWithLocalDay('2026-09-12T03:59:59Z', 2026, 9, 11)
    const after = timestampWithLocalDay('2026-09-12T04:00:00Z', 2026, 9, 12)
    expect(metricCalendarDay(before)).toBe('2026-09-11')
    expect(metricCalendarDay(after)).toBe('2026-09-12')
  })
})

describe('metric collection transcript lifecycle', () => {
  test('deadline closes a transcript that never ends and writes no rows', async () => {
    const stream = new Readable({ read() {} })
    const file = '/fixtures/transcript-that-never-ends.jsonl'
    const transcript: MetricTranscriptSource = {
      file,
      modifiedAt: new Date(),
      open: () => stream,
    }

    await expect(
      collect(30, { deadlineMs: 10, transcripts: [transcript], activity: new Map() }),
    ).rejects.toThrow(
      `metric collection deadline of 10ms exceeded while reading transcript ${file}`,
    )
    expect(stream.destroyed).toBe(true)
    expect(db().query('SELECT COUNT(*) AS count FROM metric').get()).toEqual({ count: 0 })
  })

  test('collects a small transcript', async () => {
    const now = new Date()
    const line = JSON.stringify({
      timestamp: now.toISOString(),
      message: {
        usage: {
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          input_tokens: 2,
          output_tokens: 1,
        },
      },
    })
    const transcript: MetricTranscriptSource = {
      file: '/fixtures/small.jsonl',
      modifiedAt: now,
      open: () => Readable.from([`${line}\n`]),
    }

    expect(
      await collect(30, { deadlineMs: 1_000, transcripts: [transcript], activity: new Map() }),
    ).toBe(1)
    expect(
      db()
        .query('SELECT claude_tokens, cache_read, messages, canon_tokens, other_tokens FROM metric')
        .get(),
    ).toEqual({
      claude_tokens: 11,
      cache_read: 5,
      messages: 1,
      canon_tokens: 0,
      other_tokens: 11,
    })
  })
})
