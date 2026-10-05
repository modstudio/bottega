import { expect, test } from 'bun:test'
import { noteFiledOutput } from './cli-program.ts'

test('new note output preserves its first line and reports the record id', () => {
  expect(
    noteFiledOutput({ id: 7, sightings: 1, record_id: '01990000-0000-7000-8000-000000000007' }),
  ).toEqual(['note 7 filed; 1 sighting', 'record 01990000-0000-7000-8000-000000000007'])
})
