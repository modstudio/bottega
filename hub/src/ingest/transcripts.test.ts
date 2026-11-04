import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import { DEFAULT_IDLE_CAP_MS, engagedMs } from '../../../shared/interval.ts'
import { at, resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import {
  replaceTranscriptWindow,
  resolveTranscriptRoot,
  spendingSpans,
  transcriptFilesForPass,
  transcriptFingerprintChanged,
  unreadableTranscriptRootMessage,
} from './transcripts.ts'

beforeAll(resetFixtureStore)

test('transcript fingerprints re-read growth, shrink, and replacement but skip an exact match', () => {
  const stored = { size: 100, mtimeMs: 10 }
  expect(transcriptFingerprintChanged(stored, stored)).toBe(false)
  expect(transcriptFingerprintChanged(stored, { size: 101, mtimeMs: 10 })).toBe(true)
  expect(transcriptFingerprintChanged(stored, { size: 40, mtimeMs: 11 })).toBe(true)
  expect(transcriptFingerprintChanged(stored, { size: 100, mtimeMs: 12 })).toBe(true)
})

test('a fast pass skips an unchanged fingerprint while a rebuild re-reads it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bottega-transcript-'))
  try {
    const file = join(root, 'session.jsonl')
    writeFileSync(file, '{"timestamp":"2026-11-03T12:00:00.000Z"}\n')
    const stat = statSync(file)
    writeTransaction((conn) =>
      conn
        .query('INSERT INTO transcript_fingerprint(record_id,path,size,mtime_ms) VALUES (?,?,?,?)')
        .run(newRecordId(), file, stat.size, stat.mtimeMs),
    )

    expect(transcriptFilesForPass(root, '2026-11-01')).toMatchObject({
      changed: [],
      skipped: 1,
      unreadable: 0,
    })
    expect(transcriptFilesForPass(root, '2026-11-01', true)).toMatchObject({
      changed: [{ file }],
      skipped: 0,
      unreadable: 0,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('transcript root', () => {
  test('a resolved path enables ingest and an empty value disables it', () => {
    expect(resolveTranscriptRoot('/transcripts')).toEqual({
      source: 'read',
      path: '/transcripts',
    })
    expect(resolveTranscriptRoot('')).toEqual({ source: 'disabled' })
  })

  test('an absent resolved root refuses with the remedy', () => {
    expect(unreadableTranscriptRootMessage('/missing')).toContain(
      'Cannot read hub.transcript_root /missing; set BOTTEGA_TRANSCRIPT_ROOT',
    )
  })
})

describe('spend conservation', () => {
  // The property that makes reconciliation against the day grain meaningful:
  // every token a leg saw comes back out, whatever the spans look like.
  //
  // It is asserted because losing tokens here is silent. An earlier cut
  // apportioned a leg's spend across its spans by duration and dropped every
  // token from a leg too short to have a span at all — 1.35 billion tokens on
  // one day, 32% of it, with no error and no empty column to notice.
  const conserved = (stamps: number[], spend: { at: number; tokens: number }[]) => {
    const leg = { cwd: '/fixtures/repos/workshop', ref: 'r', stamps, prompts: [], spend }
    const out = spendingSpans(leg, DEFAULT_IDLE_CAP_MS)
    return out.reduce((t, s) => t + s.tokens, 0)
  }
  const t = at('2026-09-01T10:00:00Z')

  test('a normal leg keeps every token', () => {
    expect(
      conserved(
        [t, t + 60_000, t + 120_000],
        [
          { at: t, tokens: 100 },
          { at: t + 60_000, tokens: 200 },
          { at: t + 120_000, tokens: 300 },
        ],
      ),
    ).toBe(600)
  })

  test('the last message sits on a span boundary and is still counted', () => {
    // A strict `< end` test drops exactly this one, because the final span
    // ends at the final timestamp.
    expect(conserved([t, t + 60_000], [{ at: t + 60_000, tokens: 500 }])).toBe(500)
  })

  test('a single-message leg keeps its spend and reports no duration', () => {
    const leg = {
      cwd: '/fixtures/repos/workshop',
      ref: 'r',
      stamps: [t],
      prompts: [],
      spend: [{ at: t, tokens: 900 }],
    }
    const out = spendingSpans(leg, DEFAULT_IDLE_CAP_MS)
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(900)
    expect(out[0]!.end - out[0]!.start).toBe(0) // spend without measurable time
    expect(engagedMs(out)).toBe(0)
  })

  test('spend after a capped gap is still counted', () => {
    // The span ends 10 minutes in; the message lands an hour later. It must
    // land in a span rather than falling through the gap.
    expect(conserved([t, t + 3600_000], [{ at: t + 3600_000, tokens: 77 }])).toBe(77)
  })

  test('a leg with no spend at all emits nothing', () => {
    const leg = { cwd: '/fixtures/repos/workshop', ref: 'r', stamps: [t], prompts: [], spend: [] }
    expect(spendingSpans(leg, DEFAULT_IDLE_CAP_MS)).toEqual([])
  })
})

test('transcript collector skips an unlinked projectless row and writes a valid peer', () => {
  const result = writeTransaction((conn) =>
    replaceTranscriptWindow(conn, ['fixture.jsonl'], '2026-09-01', [
      {
        source: 'claude',
        ref: 'claude:fixture.jsonl:0',
        start_at: '2026-09-01T10:00:00.000Z',
        end_at: '2026-09-01T10:01:00.000Z',
        task_key: null,
        project: 'alpha',
        claude_tokens: 10,
        via: null,
        session_id: null,
        user_id: null,
      },
      {
        source: 'claude',
        ref: 'claude:fixture.jsonl:1',
        start_at: '2026-09-01T10:02:00.000Z',
        end_at: '2026-09-01T10:03:00.000Z',
        task_key: 'NONE-1',
        project: 'not-registered',
        claude_tokens: 20,
        via: null,
        session_id: null,
        user_id: null,
      },
    ]),
  )
  expect(result).toEqual({ rows: 1, skippedUnlinked: 1 })
  expect(db().query(`SELECT ref FROM interval WHERE source='claude'`).all()).toEqual([
    { ref: 'claude:fixture.jsonl:0' },
  ])
})
