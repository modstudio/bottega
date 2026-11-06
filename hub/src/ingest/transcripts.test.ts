import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_IDLE_CAP_MS, engagedMs } from '../../../shared/interval.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { at, resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { refreshProjects } from '../projects.ts'
import {
  ingestTranscripts,
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
  const root = mkdtempSync(join(tmpdir(), 'transcript-fixture-'))
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

test('a recent unregistered transcript remains unstamped and ingests after registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcript-unregistered-'))
  const originalRoot = process.env.BOTTEGA_TRANSCRIPT_ROOT
  try {
    const file = join(root, 'session.jsonl')
    writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: '2026-11-03T12:00:00.000Z',
        cwd: '/fixtures/repos/new-project',
        sessionId: 'new-project-session',
        type: 'assistant',
        message: { usage: { input_tokens: 10 } },
      })}\n`,
    )
    process.env.BOTTEGA_TRANSCRIPT_ROOT = root

    const first = await ingestTranscripts('2026-11-01T00:00:00.000Z', undefined, null)
    expect(first).toMatchObject({ examined: 1, files: 1, rows: 0 })
    expect(
      db()
        .query<Record<string, unknown>, [string]>(
          'SELECT 1 FROM transcript_fingerprint WHERE path=?',
        )
        .get(file),
    ).toBeNull()

    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
      stdout: Buffer.from(
        JSON.stringify([
          {
            id: 99,
            record_id: '01990000-0000-7000-8000-000000001199',
            name: 'new-project',
            path: '/fixtures/repos/new-project',
            stack: null,
            canon: true,
            repository: true,
            settings: {},
          },
        ]),
      ),
      stderr: Buffer.from(''),
      exitCode: 0,
      signalCode: null,
      exitedDueToTimeout: false,
    } as unknown as ReturnType<typeof Bun.spawnSync>)
    try {
      refreshProjects()
      const second = await ingestTranscripts('2026-11-01T00:00:00.000Z', undefined, null)
      expect(second).toMatchObject({ examined: 1, files: 1, rows: 1 })
      expect(
        db()
          .query<{ project: string }, []>("SELECT project FROM interval WHERE source='claude'")
          .get(),
      ).toEqual({ project: 'new-project' })
    } finally {
      spawn.mockRestore()
      refreshProjects()
    }
  } finally {
    writeTransaction((conn) => {
      conn.query("DELETE FROM interval WHERE ref='claude:session.jsonl:0'").run()
      conn.query('DELETE FROM transcript_fingerprint WHERE path=?').run(join(root, 'session.jsonl'))
    })
    if (originalRoot === undefined) delete process.env.BOTTEGA_TRANSCRIPT_ROOT
    else process.env.BOTTEGA_TRANSCRIPT_ROOT = originalRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('transcript interval identity and attribution survive a sliding collection window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcript-window-identity-'))
  const file = join(root, 'identity.jsonl')
  const originalRoot = process.env.BOTTEGA_TRANSCRIPT_ROOT
  const taskRecordId = newRecordId()
  const line = (timestamp: string, cwd: string, type: string, message: unknown) =>
    JSON.stringify({ timestamp, cwd, sessionId: 'identity-session', type, message })
  try {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(taskRecordId, 'ALP-9123', 'alpha', 'mcp', '2026-11-03', '2026-11-03'),
    )
    writeFileSync(
      file,
      [
        line('2026-11-03T09:00:00.000Z', '/fixtures/repos/beta', 'assistant', {
          usage: { input_tokens: 1 },
        }),
        line('2026-11-03T09:01:00.000Z', '/fixtures/repos/beta', 'assistant', {
          usage: { output_tokens: 1 },
        }),
        line('2026-11-03T10:00:00.000Z', '/fixtures/repos/alpha', 'user', {
          content: 'Implement ALP-9123',
        }),
        line('2026-11-03T10:06:00.000Z', '/fixtures/repos/alpha', 'assistant', {
          usage: { input_tokens: 10 },
        }),
        line('2026-11-03T10:08:00.000Z', '/fixtures/repos/alpha', 'assistant', {
          usage: { output_tokens: 20 },
        }),
        line('2026-11-03T10:10:00.000Z', '/fixtures/repos/alpha/src', 'assistant', {
          usage: { input_tokens: 30 },
        }),
        line('2026-11-03T10:11:00.000Z', '/fixtures/repos/alpha/src', 'assistant', {
          usage: { output_tokens: 40 },
        }),
      ].join('\n') + '\n',
    )
    process.env.BOTTEGA_TRANSCRIPT_ROOT = root

    const intervalsAt = (since: string) =>
      db()
        .query<
          {
            ref: string
            start_at: string
            end_at: string
            task_key: string | null
            via: string | null
          },
          [string]
        >(
          `SELECT ref,start_at,end_at,task_key,via FROM interval
           WHERE source='claude' AND ref LIKE 'claude:identity.jsonl:%'
             AND project='alpha' AND end_at >= ?
           ORDER BY start_at`,
        )
        .all(since)

    const beforeEdge = '2026-11-03T08:55:00.000Z'
    await ingestTranscripts(beforeEdge, undefined, null, { rebuild: true })
    const first = intervalsAt(beforeEdge)

    const afterFirstMessage = '2026-11-03T10:05:00.000Z'
    await ingestTranscripts(afterFirstMessage, undefined, null, { rebuild: true })
    const second = intervalsAt(afterFirstMessage)

    const expected = [
      {
        ref: 'claude:identity.jsonl:1',
        start_at: '2026-11-03T10:00:00.000Z',
        end_at: '2026-11-03T10:08:00.000Z',
        task_key: 'ALP-9123',
        via: 'prompt',
      },
      {
        ref: 'claude:identity.jsonl:2',
        start_at: '2026-11-03T10:10:00.000Z',
        end_at: '2026-11-03T10:11:00.000Z',
        task_key: 'ALP-9123',
        via: 'sibling-leg',
      },
    ]
    expect(first).toEqual(expected)
    expect(second).toEqual(expected)
  } finally {
    writeTransaction((conn) => {
      conn.query("DELETE FROM interval WHERE ref LIKE 'claude:identity.jsonl:%'").run()
      conn.query('DELETE FROM transcript_fingerprint WHERE path=?').run(file)
      conn.query('DELETE FROM task WHERE record_id=?').run(taskRecordId)
    })
    if (originalRoot === undefined) delete process.env.BOTTEGA_TRANSCRIPT_ROOT
    else process.env.BOTTEGA_TRANSCRIPT_ROOT = originalRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('an in-window spend after a capped gap is ingested at its own instant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcript-spend-gap-'))
  const file = join(root, 'gap.jsonl')
  const originalRoot = process.env.BOTTEGA_TRANSCRIPT_ROOT
  const taskRecordId = newRecordId()
  const nine = at('2026-11-03T09:00:00.000Z')
  const noon = at('2026-11-03T12:00:00.000Z')
  const leg = {
    cwd: '/fixtures/repos/alpha',
    ref: 'gap.jsonl',
    stamps: [nine, noon],
    prompts: ['Implement ALP-9124'],
    spend: [{ at: noon, tokens: 55 }],
  }
  try {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(taskRecordId, 'ALP-9124', 'alpha', 'mcp', '2026-11-03', '2026-11-03'),
    )
    writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: '2026-11-03T09:00:00.000Z',
          cwd: leg.cwd,
          sessionId: 'gap-session',
          type: 'user',
          message: { content: leg.prompts[0] },
        }),
        JSON.stringify({
          timestamp: '2026-11-03T12:00:00.000Z',
          cwd: leg.cwd,
          sessionId: 'gap-session',
          type: 'assistant',
          message: { usage: { input_tokens: 55 } },
        }),
      ].join('\n') + '\n',
    )
    process.env.BOTTEGA_TRANSCRIPT_ROOT = root

    await ingestTranscripts('2026-11-03T10:00:00.000Z', undefined, null, { rebuild: true })

    expect(
      db()
        .query<{ start_at: string; end_at: string; claude_tokens: number }, []>(
          `SELECT start_at,end_at,claude_tokens FROM interval
           WHERE source='claude' AND ref='claude:gap.jsonl:0'`,
        )
        .all(),
    ).toEqual([
      {
        start_at: '2026-11-03T12:00:00.000Z',
        end_at: '2026-11-03T12:00:00.000Z',
        claude_tokens: 55,
      },
    ])
    expect(
      spendingSpans(leg, DEFAULT_IDLE_CAP_MS).reduce((total, span) => total + span.tokens, 0),
    ).toBe(55)
  } finally {
    writeTransaction((conn) => {
      conn.query("DELETE FROM interval WHERE ref='claude:gap.jsonl:0'").run()
      conn.query('DELETE FROM transcript_fingerprint WHERE path=?').run(file)
      conn.query('DELETE FROM task WHERE record_id=?').run(taskRecordId)
    })
    if (originalRoot === undefined) delete process.env.BOTTEGA_TRANSCRIPT_ROOT
    else process.env.BOTTEGA_TRANSCRIPT_ROOT = originalRoot
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
    // The measured span ends 10 minutes in; the message lands an hour later
    // and gets a zero-length span at its own instant.
    const out = spendingSpans(
      {
        cwd: '/fixtures/repos/workshop',
        ref: 'r',
        stamps: [t, t + 3600_000],
        prompts: [],
        spend: [
          { at: t + 3600_000, tokens: 70 },
          { at: t + 3600_000, tokens: 7 },
        ],
      },
      DEFAULT_IDLE_CAP_MS,
    )
    expect(out).toEqual([
      { start: t, end: t + DEFAULT_IDLE_CAP_MS, tokens: 0 },
      { start: t + 3600_000, end: t + 3600_000, tokens: 77 },
    ])
    expect(out.reduce((total, span) => total + span.tokens, 0)).toBe(77)
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
  expect(result).toEqual({ rows: 1, unchanged: 0, skippedUnlinked: 1 })
  expect(db().query(`SELECT ref FROM interval WHERE source='claude'`).all()).toEqual([
    { ref: 'claude:fixture.jsonl:0' },
  ])
})

test('transcript replacement writes only changed interval values', () => {
  const row = {
    source: 'claude' as const,
    ref: 'claude:unchanged.jsonl:0',
    start_at: '2026-09-01T11:00:00.000Z',
    end_at: '2026-09-01T11:01:00.000Z',
    task_key: null,
    project: 'alpha',
    claude_tokens: 10,
    via: null,
    session_id: null,
    user_id: null,
  }
  const replace = (claudeTokens = row.claude_tokens) =>
    writeTransaction((conn) =>
      replaceTranscriptWindow(conn, ['unchanged.jsonl'], '2026-09-01', [
        { ...row, claude_tokens: claudeTokens },
      ]),
    )

  expect(replace()).toEqual({ rows: 1, unchanged: 0, skippedUnlinked: 0 })
  expect(replace()).toEqual({ rows: 0, unchanged: 1, skippedUnlinked: 0 })
  expect(replace(11)).toEqual({ rows: 1, unchanged: 0, skippedUnlinked: 0 })
})
