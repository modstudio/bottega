import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { storedMachineId } from '../../../shared/machine-config.ts'
import { carryMachineIdentity, machineIdStored } from './machine-identity-store.ts'

test('an orchestrator identity is carried to shared configuration once', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-carry-'))
  const database = new Database(':memory:')
  try {
    database.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const id = '01990000-0000-7000-8000-000000001240'
    database.query("INSERT INTO schema_meta VALUES ('machine_id', ?)").run(id)
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      id,
    )
    expect(machineIdStored(database)).toBeNull()
    expect(storedMachineId(env)).toBe(id)
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      id,
    )
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
