import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { isUsableSpareRunIdentifier } from './spare-runner.ts'

test('spare dispatch accepts every run identifier that run wait accepts', () => {
  expect(isUsableSpareRunIdentifier('r42')).toBe(true)
  expect(isUsableSpareRunIdentifier('42')).toBe(true)
  expect(isUsableSpareRunIdentifier(newRecordId())).toBe(true)
  expect(isUsableSpareRunIdentifier('not-a-run')).toBe(false)
})
