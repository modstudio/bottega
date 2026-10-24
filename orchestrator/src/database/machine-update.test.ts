import { expect, test } from 'bun:test'
import { dir } from '../../test/fixtures/store.ts'
import { db } from './db.ts'
import { machineUpdateCommand } from './machine-update.ts'
import { migrationDrain, setMigrationDrain } from './migration-drain.ts'
import { migrationJournal } from './migrations.ts'

test("machine update clears a dead holder's marker before deciding", async () => {
  setMigrationDrain(db(), '0155_rebuild', { pid: 4_200_000, startTime: 'old birth' })
  const gitCalls: string[][] = []
  let migrated = false
  await machineUpdateCommand(
    { log: () => {} },
    {
      cwd: dir,
      authorityRefusal: () => null,
      project: () => ({ name: 'migration-update-fixture', path: dir, settings: { trunk: 'main' } }),
      git: (_cwd, args) => {
        gitCalls.push(args)
        return args[0] === 'show' ? JSON.stringify({ entries: migrationJournal() }) : ''
      },
      migrate: () => {
        migrated = true
      },
    },
  )
  expect(migrationDrain(db())).toBeNull()
  expect(migrated).toBe(true)
  expect(gitCalls.map((args) => args[0])).toEqual(['fetch', 'show', 'pull'])
})
