import { Database } from 'bun:sqlite'
import {
  formatIdentityInventory,
  orchestratorIdentityInventory,
} from '../src/database/identity-inventory.ts'
import { applyMigrations } from '../src/database/migrations.ts'

const database = new Database(':memory:')
try {
  applyMigrations(database)
  console.log(formatIdentityInventory(orchestratorIdentityInventory(database)))
} finally {
  database.close()
}
