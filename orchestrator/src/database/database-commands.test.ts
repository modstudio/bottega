import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migrateCommand } from './database-commands.ts'

function actions(fill: () => Promise<unknown>, contracted = false) {
  const calls: string[] = []
  return {
    calls,
    value: {
      async contracted() {
        calls.push('contracted')
        return contracted
      },
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

test('migrate contracts only after identity fill succeeds', async () => {
  const scenario = actions(async () => undefined)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual([
    'contracted',
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
  expect(scenario.calls).toEqual(['contracted', 'before:0115_project_identity_contract', 'fill'])
})

test('migrate skips the boundary and fill when the identity contract is recorded', async () => {
  const scenario = actions(async () => {
    throw new Error('fill must not run')
  }, true)
  await migrateCommand({ log: () => {} }, scenario.value)
  expect(scenario.calls).toEqual(['contracted', 'after', 'backfill'])
})
