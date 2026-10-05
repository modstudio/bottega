import { expect, test } from 'bun:test'
import { parseFiledNoteOutput } from './hub-notes.ts'

test('the note filer returns the additional record id without changing existing parsing', () => {
  expect(
    parseFiledNoteOutput(
      'near 3 score 0.750  similar\nnote 7 filed; 1 sighting\nrecord 01990000-0000-7000-8000-000000000007',
    ),
  ).toMatchObject({
    noteId: 7,
    recordId: '01990000-0000-7000-8000-000000000007',
    candidateIds: [3],
  })
})
