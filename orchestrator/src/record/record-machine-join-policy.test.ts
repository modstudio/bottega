import { expect, test } from 'bun:test'
import {
  lowestFreeMachineJoinNameplate,
  MACHINE_JOIN_NAMEPLATE_MAX,
  machineJoinAvailability,
  machineJoinIsCrowded,
  machineJoinPhaseDecision,
} from './record-machine-join-policy.ts'

test('machine join availability burns before expiry and expires at the boundary', () => {
  expect(machineJoinAvailability({ now: 10, expiresAt: 10, failedAt: null })).toBe('expired')
  expect(machineJoinAvailability({ now: 9, expiresAt: 10, failedAt: 8 })).toBe('burned')
  expect(machineJoinAvailability({ now: 9, expiresAt: 10, failedAt: null })).toBe('active')
})

test('machine join admits either existing side and refuses a third distinct side', () => {
  expect(machineJoinIsCrowded(['a', 'b'], 'a')).toBe(false)
  expect(machineJoinIsCrowded(['a'], 'b')).toBe(false)
  expect(machineJoinIsCrowded(['a', 'b'], 'c')).toBe(true)
})

test('machine join phase resends only an identical body', () => {
  const body = new Uint8Array([1, 2])
  expect(machineJoinPhaseDecision(null, body)).toBe('insert')
  expect(machineJoinPhaseDecision(new Uint8Array([1, 2]), body)).toBe('resend')
  expect(machineJoinPhaseDecision(new Uint8Array([2, 1]), body)).toBe('conflict')
})

test('machine join allocates the lowest free positive nameplate', () => {
  expect(lowestFreeMachineJoinNameplate(new Set())).toBe(1)
  expect(lowestFreeMachineJoinNameplate(new Set([1, 3]))).toBe(2)
  expect(lowestFreeMachineJoinNameplate(new Set([MACHINE_JOIN_NAMEPLATE_MAX]))).toBe(1)
})
