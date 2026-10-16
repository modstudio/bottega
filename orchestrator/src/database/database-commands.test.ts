import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migrateCommand } from './database-commands.ts'

function actions(fill: () => Promise<unknown>) {
  const calls: string[] = []
  return {
    calls,
    value: {
      migrate(input?: { beforeMigration?: string }) {
        calls.push(input?.beforeMigration ? `before:${input.beforeMigration}` : 'after')
        return { path: '/store', versions: input ? ['0113'] : ['0114'] }
      },
      async fill() {
        calls.push('fill')
        return fill()
      },
      backfill() {
        calls.push('backfill')
        return { updated: 0, missing: 0 }
      },
    },
  }
}

test.each(['hosted fill', 'local mint'])('migrate contracts only after %s succeeds', async () => {
  const scenario = actions(async () => undefined)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'before:0115_project_identity_contract',
    'fill',
    'after',
    'backfill',
  ])
})

test('migrate stops before contraction when configured hosting refuses the fill', async () => {
  const scenario = actions(async () => {
    throw new Error(`hosted record unreachable; cleared by: ${PLATFORM_SLUG} record doctor`)
  })
  await expect(migrateCommand({ log: () => {} }, scenario.value)).rejects.toThrow(
    `cleared by: ${PLATFORM_SLUG} record doctor`,
  )
  expect(scenario.calls).toEqual(['before:0115_project_identity_contract', 'fill'])
})
