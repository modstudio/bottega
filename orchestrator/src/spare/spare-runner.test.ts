import { expect, test } from 'bun:test'
import { isUsableSpareRunIdentifier } from './spare-runner.ts'

test('spare dispatch accepts porcelain run labels that run wait accepts', () => {
  expect(isUsableSpareRunIdentifier('r42')).toBe(true)
  expect(isUsableSpareRunIdentifier('42')).toBe(true)
  expect(isUsableSpareRunIdentifier('mine/r42')).toBe(false)
  expect(isUsableSpareRunIdentifier('not-a-run')).toBe(false)
})
