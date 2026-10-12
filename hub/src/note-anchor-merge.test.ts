import { expect, test } from 'bun:test'
import { mergeNoteAnchors } from './note-anchor-merge.ts'

test('anchor merge keeps historical anchors and appends each identified sighting once', () => {
  const historical: { id?: string; source: string } = { source: 'old' }
  const first = { id: '01990000-0000-7000-8000-000000000001', source: 'first' }
  const second = { id: '01990000-0000-7000-8000-000000000002', source: 'second' }

  expect(mergeNoteAnchors([historical, first], [historical, first, second])).toEqual({
    anchors: [historical, first, second],
    sightings: 3,
    appended: 1,
  })
  expect(mergeNoteAnchors([historical, first, second], [first, second])).toEqual({
    anchors: [historical, first, second],
    sightings: 3,
    appended: 0,
  })
})
