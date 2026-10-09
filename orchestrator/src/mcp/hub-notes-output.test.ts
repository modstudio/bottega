import { expect, test } from 'bun:test'
import { parseFiledNoteOutput } from './hub-notes.ts'

test('the note filer reads the UUID, label, and candidate identities from JSON', () => {
  expect(
    parseFiledNoteOutput(
      JSON.stringify({
        record_id: '01990000-0000-7000-8000-000000000007',
        number: 7,
        label: 'workshop#7',
        sightings: 1,
        candidates: [
          {
            record_id: '01990000-0000-7000-8000-000000000003',
            number: 3,
            label: 'workshop#3',
            text: 'similar',
            score: 0.75,
          },
        ],
      }),
    ),
  ).toMatchObject({
    noteRecordId: '01990000-0000-7000-8000-000000000007',
    noteLabel: 'workshop#7',
    candidateNotes: [
      { recordId: '01990000-0000-7000-8000-000000000003', label: 'workshop#3' },
    ],
  })
})
