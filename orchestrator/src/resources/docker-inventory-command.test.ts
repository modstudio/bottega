import { expect, test } from 'bun:test'
import {
  decideDockerInventoryAvailability,
  executableAbsentFrom,
} from './docker-inventory-command.ts'

test('Docker executable absence is classified structurally', () => {
  expect(executableAbsentFrom(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBeTrue()
  expect(executableAbsentFrom(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBeFalse()
})

test('Docker inventory availability proceeds only with an available inventory', () => {
  expect(decideDockerInventoryAvailability({ ok: true, executableAbsent: false })).toBe('proceed')
})

test('Docker inventory availability skips when the executable is absent', () => {
  expect(decideDockerInventoryAvailability({ ok: false, executableAbsent: true })).toBe(
    'docker-absent',
  )
})

test('Docker inventory availability fails for a nonzero Docker exit', () => {
  expect(decideDockerInventoryAvailability({ ok: false, executableAbsent: false })).toBe('fail')
})

test('Docker inventory availability treats a timeout as failure', () => {
  const timeout = { ok: false, executableAbsent: false }
  expect(decideDockerInventoryAvailability(timeout)).toBe('fail')
})
