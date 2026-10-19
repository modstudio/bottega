import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { upsertProject } from '../project/projects.ts'
import { portSourceProjectLabel } from './port-commands.ts'

test('a port source renders by registered name or by hosted project id', () => {
  const known = newRecordId()
  const unknown = newRecordId()
  upsertProject({
    recordId: known,
    name: 'known-cross-space-source',
    path: '/tmp/known-cross-space-source',
    settings: {},
  })

  expect(portSourceProjectLabel(known)).toBe('known-cross-space-source')
  expect(portSourceProjectLabel(unknown)).toBe(`project:${unknown}`)
})
