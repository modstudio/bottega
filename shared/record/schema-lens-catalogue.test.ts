import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as catalogue from './schema-lens-catalogue.ts'

const tables = Object.values(catalogue)

describe('hosted lens catalogue schema', () => {
  test('enables RLS with tenant policies on every exported table', () => {
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
