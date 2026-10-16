import { expect, test } from 'bun:test'
import { landingCommonValues } from './record-sync-service.ts'

test('hosted landing evidence values ignore the machine-local id', () => {
  const values = landingCommonValues({
    id: '01990000-0000-7000-8000-000000000001',
    spaceId: '01990000-0000-7000-8000-000000000002',
    machineId: '01990000-0000-7000-8000-000000000003',
    localId: 42,
    createdAt: '2026-10-16T18:00:00.000Z',
    updatedAt: '2026-10-16T18:00:00.000Z',
  })

  expect(values).not.toHaveProperty('localId')
})
