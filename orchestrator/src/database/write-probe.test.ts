import { expect, test } from 'bun:test'
import {
  isWriteProbeTable,
  staleWriteProbe,
  WRITE_PROBE_TABLE_PREFIX,
  writeProbeOwnerPid,
} from './write-probe.ts'

test('probe names require the reserved prefix and an all-digit pid', () => {
  expect(isWriteProbeTable(`${WRITE_PROBE_TABLE_PREFIX}12345`)).toBe(true)
  expect(isWriteProbeTable(`${WRITE_PROBE_TABLE_PREFIX}not_a_pid`)).toBe(false)
  expect(isWriteProbeTable('other_12345')).toBe(false)
  expect(writeProbeOwnerPid(`${WRITE_PROBE_TABLE_PREFIX}12345`)).toBe(12345)
})

test('stale probe classification uses supplied process facts', () => {
  const probe = `${WRITE_PROBE_TABLE_PREFIX}12345`
  expect(staleWriteProbe(probe, 54321, false)).toBe(true)
  expect(staleWriteProbe(probe, 54321, true)).toBe(false)
  expect(staleWriteProbe(probe, 12345, false)).toBe(false)
  expect(staleWriteProbe(`${WRITE_PROBE_TABLE_PREFIX}not_a_pid`, 54321, false)).toBe(false)
})
