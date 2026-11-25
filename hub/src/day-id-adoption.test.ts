import { expect, test } from 'bun:test'
import { decideDayIdAdoption } from './day-id-adoption.ts'
import type { HostedPushChange, HostedPushOutcome } from './push-contract.ts'

const localId = '01990000-0000-7000-8000-000000002601'
const hostedId = '01990000-0000-7000-8000-000000002602'
const machineId = '01990000-0000-7000-8000-000000002603'
const change = {
  table: 'hub_day',
  id: localId,
  op: 'upsert',
  row: { id: localId, day: '2026-11-20', machine_id: machineId },
} as HostedPushChange
const outcome: HostedPushOutcome = {
  id: localId,
  status: 'rejected',
  reason: 'day identity conflict',
  conflict: {
    code: 'day-identity-conflict',
    day: '2026-11-20',
    incomingId: localId,
    existingId: hostedId,
    machineId,
  },
}

test('adopts the hosted id for this machine and day', () => {
  expect(decideDayIdAdoption(change, outcome, machineId)).toEqual({
    action: 'adopt',
    hostedId,
  })
})

test.each([
  ['absent conflict', { ...outcome, conflict: undefined }],
  ['same id', { ...outcome, conflict: { ...outcome.conflict!, existingId: localId } }],
  ['different day', { ...outcome, conflict: { ...outcome.conflict!, day: '2026-11-19' } }],
  ['hidden machine', { ...outcome, conflict: { ...outcome.conflict!, machineId: null } }],
  [
    'another machine',
    {
      ...outcome,
      conflict: {
        ...outcome.conflict!,
        machineId: '01990000-0000-7000-8000-000000002604',
      },
    },
  ],
] as const)('does not adopt for %s', (_name, rejected) => {
  expect(decideDayIdAdoption(change, rejected, machineId)).toEqual({ action: 'none' })
})

test('does not adopt for another table or operation', () => {
  expect(
    decideDayIdAdoption(
      { ...change, table: 'hub_interval' } as HostedPushChange,
      outcome,
      machineId,
    ),
  ).toEqual({ action: 'none' })
  expect(
    decideDayIdAdoption({ table: 'hub_day', id: localId, op: 'delete' }, outcome, machineId),
  ).toEqual({ action: 'none' })
})
