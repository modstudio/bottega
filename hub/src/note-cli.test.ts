import { expect, test } from 'bun:test'
import { noteCuratorPrompt } from './note.ts'
import {
  NOTE_DUPLICATE_PROMPT,
  NOTE_USAGE,
  noteCandidateLine,
  noteDropLine,
  noteFiledJson,
  noteFiledOutput,
  noteHelpRequested,
  noteKeepLine,
  noteListLine,
  noteSameLine,
  noteStaleLine,
} from './note-cli.ts'

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

test('note help scanning owns note value flags and usage', () => {
  expect(NOTE_USAGE).toContain('hub note new')
  expect(noteHelpRequested(['new', 'text', '--help'])).toBe(true)
  expect(noteHelpRequested(['new', 'text', '--same-as', '--help'])).toBe(false)
  expect(noteHelpRequested(['list', '--project', '--help'])).toBe(false)
})
