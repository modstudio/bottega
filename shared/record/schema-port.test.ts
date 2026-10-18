import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as port from './schema-port.ts'

const tables = Object.values(port)

describe('hosted port schema', () => {
  test('exports every port table with tenant policies', () => {
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual([
      'port_baseline',
      'port_doctrine',
      'port_pair',
      'port_ref',
      'port_ref_source',
      'port_skip',
    ])

    for (const table of tables) {
      const config = getTableConfig(table)
      expect(config.enableRLS).toBe(true)
      expect(config.policies.map((policy) => policy.name).sort()).toEqual([
        `${config.name}_space_delete`,
        `${config.name}_space_insert`,
        `${config.name}_space_select`,
        `${config.name}_space_update`,
      ])
    }
  })
})
