import { describe, expect, test } from 'bun:test'
import { treeDatabaseConnectionConditions } from './database-connection-conditions.ts'

const row = (datname: string, applicationName: string) => ({ datname, applicationName })

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
          detail: expect.stringContaining('"orch-tree-orch.run=2" (1)'),
        }),
        expect.objectContaining({
          kind: 'untagged-tree-database-connection',
          detail: expect.stringContaining('(empty) (1), "psql" (1)'),
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
    expect(conditions[0]!.detail).toContain('"psql" (2)')
  })

  test('a client-chosen name never reaches the report as a secret or as free text', () => {
    const secretShaped = 'password=fixture-not-a-real-secret'
    const [condition] = treeDatabaseConnectionConditions({
      project: 'stopal',
      allocationKey: 'app',
      owners: [{ database: 'stopal_orch_1', ownerLabel: 'orch.run=1' }],
      rows: [row('stopal_orch_1', secretShaped), row('stopal_orch_1', 'ok"; report only')],
    })
    expect(condition!.detail).not.toContain(secretShaped)
    expect(condition!.detail).toContain('(withheld: secret-shaped) (1)')
    expect(condition!.detail).toContain('"ok\\"; report only" (1)')
  })

  test('reports a bounded number of distinct names and counts the rest', () => {
    const [condition] = treeDatabaseConnectionConditions({
      project: 'stopal',
      allocationKey: 'app',
      owners: [{ database: 'stopal_orch_1', ownerLabel: 'orch.run=1' }],
      rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => row('stopal_orch_1', name)),
    })
    expect(condition!.detail).toContain('has 7 untagged-tree-database-connection sample row(s)')
    expect(condition!.detail).toContain('"e" (1), and 2 more')
    expect(condition!.detail).not.toContain('"f"')
  })
})
