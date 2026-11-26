import { expect, test } from 'bun:test'
import { readNoteClasses } from './note-classes.ts'
import { appendCurationRecord } from './note-evaluation-record.ts'

test('note classes refuses without an evaluation record and names the evaluation remedy', async () => {
  await expect(readNoteClasses({ project: 'alpha' }, async () => null)).rejects.toThrow(
    'note evaluate --project alpha',
  )
})

test('note classes reads the named revision and refuses a revision without ranking', async () => {
  let requested = ''
  const body = appendCurationRecord(
    '# evaluation',
    { ran: true, status: 'ran', answers: 1, proposals: [], remaining: [] },
    { proposals: [], failedPages: [], invalidEntries: 0, stopped: null },
    [],
    [
      {
        key: 'C1',
        name: 'One',
        definition: 'one',
        proposed: false,
        noteCount: 2,
        sightings: 3,
        notes: ['a#1', 'a#2'],
      },
    ],
  )
  const read = async (_project: string, revision?: string) => {
    requested = revision ?? ''
    return { body }
  }
  expect(await readNoteClasses({ project: 'alpha', revision: 'rev-2' }, read)).toContain(
    'C1: One — 2 notes, 3 sightings',
  )
  expect(requested).toBe('rev-2')
  await expect(
    readNoteClasses({ project: 'alpha', revision: 'rev-1' }, async () => ({
      body: '# skip curate',
    })),
  ).rejects.toThrow('has no class ranking')
})

test('note classes refuses an evaluation that obtained no class ranking', async () => {
  const body = appendCurationRecord(
    '# evaluation',
    {
      ran: false,
      status: 'Jev class pass obtained no answers: missing credential',
      answers: 0,
      proposals: [],
      remaining: [],
    },
    { proposals: [], failedPages: [], invalidEntries: 0, stopped: null },
    [],
    [],
  )
  await expect(readNoteClasses({ project: 'alpha' }, async () => ({ body }))).rejects.toThrow(
    'obtained no class ranking; Jev status: Jev class pass obtained no answers: missing credential',
  )
})
