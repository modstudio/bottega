import { beforeEach, expect, test } from 'bun:test'
import { noteHostedFetch } from '../test/note-hosted-fetch.ts'
import { fixtureRecordId, resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { noteCuratorPrompt } from './note.ts'
import {
  NOTE_DUPLICATE_PROMPT,
  noteCandidateLine,
  noteDropLine,
  noteFiledJson,
  noteFiledOutput,
  noteKeepLine,
  noteListLine,
  noteListRows,
  noteSameLine,
  noteStaleLine,
} from './note-cli.ts'
import { listSlimNotes } from './note-read.ts'

beforeEach(resetFixtureStore)

const NOTE_LIST_RESPONSE_BYTE_BUDGET = 64 * 1024

function seedSlimListNotes() {
  const largeAnchor = JSON.stringify([{ session_id: 'session-a', context: 'x'.repeat(4_000) }])
  writeTransaction((conn) => {
    const insert = conn.prepare(
      `INSERT INTO note(record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
       VALUES (?,?,?,?,?,1,?,?)`,
    )
    for (let number = 1; number <= 75; number++) {
      const at = new Date(Date.UTC(2026, 10, 20, 0, number)).toISOString()
      insert.run(
        fixtureRecordId(10_000 + number),
        number,
        'gamma',
        `budget note ${number} ${'body'.repeat(40)}`,
        largeAnchor,
        at,
        at,
      )
    }
    insert.run(
      fixtureRecordId(11_000),
      1,
      'workshop',
      'budget note workshop',
      largeAnchor,
      '2026-11-20T03:00:00.000Z',
      '2026-11-20T03:00:00.000Z',
    )
  })
}

function countingFetch() {
  const calls: string[] = []
  let bytes = 0
  const fetch = async (input: string, init?: RequestInit) => {
    const response = await noteHostedFetch(input, init)
    const url = new URL(input)
    calls.push(url.pathname)
    if (url.pathname === '/v1/notes/list')
      bytes += (await response.clone().arrayBuffer()).byteLength
    return response
  }
  return { fetch, calls, bytes: () => bytes }
}

test('new note output preserves its first line and reports the record id', () => {
  expect(
    noteFiledOutput({
      label: 'workshop#7',
      sightings: 1,
      record_id: '01990000-0000-7000-8000-000000000007',
    }),
  ).toEqual(['note workshop#7 filed; 1 sighting', 'record 01990000-0000-7000-8000-000000000007'])
})

test('every note text surface uses the project label', () => {
  const note = { label: 'workshop#7', sightings: 2, text: 'Boundary drift' }
  expect(noteListLine(note)).toContain('workshop#7')
  expect(noteListLine({ ...note, stale_at: null, stale_reason: 'branch topic was deleted' })).toBe(
    'workshop#7           x2  Boundary drift  anchor gone: branch topic was deleted',
  )
  expect(noteKeepLine(note, false)).toBe('note workshop#7 kept for this session')
  expect(noteSameLine(note)).toBe('note workshop#7 now has 2 sightings')
  expect(noteDropLine({ ...note, stale_reason: 'dropped: fixed' })).toBe(
    'note workshop#7 dropped: dropped: fixed',
  )
  expect(noteStaleLine({ label: note.label, reason: 'anchor vanished' })).toBe(
    'note workshop#7: anchor vanished',
  )
  expect(noteCandidateLine({ ...note, score: 0.75 })).toBe('workshop#7 score 0.750  Boundary drift')
  expect(NOTE_DUPLICATE_PROMPT).toContain('note label')
  expect(noteCuratorPrompt([note])).toContain(
    'genuine-duplicate-of-project#number, earned-promotion',
  )
  expect(noteCuratorPrompt([note])).toContain('workshop#7: Boundary drift')
})

test('new note JSON carries UUID, number, label, and candidate identities', () => {
  expect(
    noteFiledJson(
      {
        record_id: '01990000-0000-7000-8000-000000000007',
        number: 7,
        label: 'workshop#7',
        sightings: 1,
      },
      [
        {
          record_id: '01990000-0000-7000-8000-000000000003',
          number: 3,
          label: 'workshop#3',
          text: 'Similar',
          score: 0.75,
        },
      ],
    ),
  ).toEqual({
    record_id: '01990000-0000-7000-8000-000000000007',
    number: 7,
    label: 'workshop#7',
    sightings: 1,
    candidates: [
      {
        record_id: '01990000-0000-7000-8000-000000000003',
        number: 3,
        label: 'workshop#3',
        text: 'Similar',
        score: 0.75,
      },
    ],
  })
})

test('CLI slim list budgets calls and bytes for human and JSON output', async () => {
  seedSlimListNotes()
  const human = countingFetch()
  const hosted = { baseUrl: 'https://hub.example.test', token: 'test', fetch: human.fetch }
  const humanResult = await noteListRows(undefined, { project: 'gamma' }, undefined, hosted)
  expect(humanResult.notes).toHaveLength(50)
  expect(humanResult.total).toBe(75)
  expect(human.calls.filter((path) => path === '/v1/notes/list')).toHaveLength(1)
  expect(human.calls).not.toContain('/v1/notes')
  expect(human.bytes()).toBeGreaterThan(10 * 1024)
  expect(human.bytes()).toBeLessThan(NOTE_LIST_RESPONSE_BYTE_BUDGET)

  const json = countingFetch()
  const jsonResult = await noteListRows(undefined, { project: 'gamma', json: true }, undefined, {
    ...hosted,
    fetch: json.fetch,
  })
  expect(jsonResult.notes).toHaveLength(75)
  expect(json.calls.filter((path) => path === '/v1/notes/list')).toHaveLength(1)
  expect(json.calls).not.toContain('/v1/notes')

  const union = countingFetch()
  await noteListRows(undefined, { json: true }, undefined, { ...hosted, fetch: union.fetch })
  expect(union.calls.filter((path) => path === '/v1/notes/list')).toHaveLength(2)
  expect(union.calls).not.toContain('/v1/notes')
})

test('local and hosted slim lists have filter and order parity', async () => {
  seedSlimListNotes()
  const filters = {
    project: 'gamma',
    stale: false,
    actionable: true,
    session: 'session-a',
    kept: false,
    text: 'budget NOTE 2',
    limit: 8,
  }
  const local = await listSlimNotes(filters, { baseUrl: '' })
  const hosted = await listSlimNotes(filters, {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: noteHostedFetch,
  })
  expect(hosted.notes.map((note) => note.record_id)).toEqual(
    local.notes.map((note) => note.record_id),
  )
  expect(hosted.total).toBe(local.total)
})
