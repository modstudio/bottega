import { describe, expect, test } from 'bun:test'
import { treeDatabaseConnectionConditions } from './database-connection-conditions.ts'

const row = (datname: string, applicationName: string) => ({
  datname,
  applicationName,
  backendStart: '2026-10-07T12:00:00.000Z',
  state: 'active',
})

describe('tree database connection classification', () => {
  test('accepts the owner tag and orch-admin', () => {
    expect(
      treeDatabaseConnectionConditions({
        project: 'stopal',
        allocationKey: 'app',
        owners: [{ database: 'stopal_orch_1', ownerLabel: 'orch.run=1' }],
        rows: [row('stopal_orch_1', 'orch-tree-orch.run=1'), row('stopal_orch_1', 'orch-admin')],
      }),
    ).toEqual([])
  })

  test('classifies another tree tag separately from empty and client-default tags', () => {
    const conditions = treeDatabaseConnectionConditions({
      project: 'stopal',
      allocationKey: 'app',
      owners: [{ database: 'stopal_orch_1', ownerLabel: 'orch.run=1' }],
      rows: [
        row('stopal_orch_1', 'orch-tree-orch.run=2'),
        row('stopal_orch_1', 'psql'),
        row('stopal_orch_1', ''),
      ],
    })
    expect(conditions).toHaveLength(2)
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'cross-tree-database-connection',
          detail: expect.stringContaining('orch-tree-orch.run=2 (1)'),
        }),
        expect.objectContaining({
          kind: 'untagged-tree-database-connection',
          detail: expect.stringContaining('(empty) (1), psql (1)'),
        }),
      ]),
    )
  })

  test('skips databases without a live owner and aggregates by database and kind', () => {
    const conditions = treeDatabaseConnectionConditions({
      project: 'stopal',
      allocationKey: 'app',
      owners: [{ database: 'stopal_orch_1', ownerLabel: 'orch.run=1' }],
      rows: [
        row('stopal_orch_1', 'psql'),
        row('stopal_orch_1', 'psql'),
        row('stopal_orch_2', 'orch-tree-orch.run=3'),
      ],
    })
    expect(conditions).toHaveLength(1)
    expect(conditions[0]).toMatchObject({
      kind: 'untagged-tree-database-connection',
      subject: 'stopal:app:postgres:stopal_orch_1',
      action: 'report only',
    })
    expect(conditions[0]!.detail).toContain('has 2 untagged-tree-database-connection sample row(s)')
    expect(conditions[0]!.detail).toContain('psql (2)')
  })
})
