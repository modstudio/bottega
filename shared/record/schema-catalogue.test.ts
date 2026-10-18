import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as catalogue from './schema-catalogue.ts'

const tables = Object.values(catalogue)

describe('hosted catalogue schema', () => {
  test('exports every workflow and lens catalogue table with tenant policies', () => {
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual([
      'lens',
      'lens_profile',
      'lens_profile_revision',
      'lens_revision',
      'project_lens_profile',
      'project_lens_profile_revision',
      'step_catalogue',
      'step_catalogue_event',
      'step_catalogue_version',
      'workflow',
      'workflow_event',
      'workflow_version',
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
