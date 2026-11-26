import { expect, test } from 'bun:test'
import { readNoteClasses } from './note-classes.ts'
import { appendCurationRecord } from './note-evaluation-record.ts'

const current = (body: string) => ({ slug: 'note-evaluation', body })

test('note classes refuses without an evaluation record and names the evaluation remedy', async () => {
  await expect(
    readNoteClasses(
      { project: 'alpha' },
      { list: async () => [], revision: async () => ({ body: '' }) },
    ),
  ).rejects.toThrow('note evaluate --project alpha')
})

test('note classes reads the named revision and refuses a revision without ranking', async () => {
  let requested = ''
  const body = appendCurationRecord(
    '# evaluation',
    { ran: true, status: 'ran', answers: 1, proposals: [], remaining: [] },
    { proposals: [], failedPages: [], invalidEntries: 0, stopped: null, ranking: [] },
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
  const dependencies = {
    list: async () => [current('# old')] as never,
    revision: async (_project: string, revision: string) => {
      requested = revision
      return { body }
    },
  }
  expect(await readNoteClasses({ project: 'alpha', revision: 'rev-2' }, dependencies)).toContain(
    'C1: One — 2 notes, 3 sightings',
  )
  expect(requested).toBe('rev-2')
  await expect(
    readNoteClasses(
      { project: 'alpha', revision: 'rev-1' },
      { ...dependencies, revision: async () => ({ body: '# skip curate' }) },
    ),
  ).rejects.toThrow('has no class ranking')
})
