import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../shared/config-directory.ts'
import { KEYSTORE_ENV } from '../../shared/key-store.ts'
import { signInCommand } from '../src/record/record-auth-command.ts'
import { registerCustomerAuthProof } from './postgres-customer-auth-proof.ts'

/** Registers sign-in proofs against an empty file store, never the login keychain. */
export function registerPostgresSignInProofs(input: {
  repairSpace: () => string
  succeeds: (source: string) => string
  repair: { email: string; password: string }
  customer: { email: string; password: string; userId: () => string }
}): void {
  describe('sign-in with an isolated machine key store', () => {
    let configRoot = ''
    let previousConfigHome: string | undefined
    let previousKeyStore: string | undefined

    beforeEach(() => {
      previousConfigHome = process.env[CONFIG_HOME_ENV]
      previousKeyStore = process.env[KEYSTORE_ENV]
      configRoot = mkdtempSync(join(tmpdir(), 'postgres-sign-in-config-'))
      process.env[CONFIG_HOME_ENV] = configRoot
      process.env[KEYSTORE_ENV] = 'file'
    })

    afterEach(() => {
      if (previousConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
      else process.env[CONFIG_HOME_ENV] = previousConfigHome
      if (previousKeyStore === undefined) delete process.env[KEYSTORE_ENV]
      else process.env[KEYSTORE_ENV] = previousKeyStore
      rmSync(configRoot, { recursive: true, force: true })
    })

    test('sign-in repairs a missing personal space before making it active', async () => {
      input.succeeds(
        `DELETE FROM membership WHERE space_id='${input.repairSpace()}';
         DELETE FROM space WHERE id='${input.repairSpace()}';`,
      )
      const output: string[] = []
      await signInCommand(input.repair.email, async () => input.repair.password, {
        log: (value) => output.push(value),
      })
      expect(output).toEqual([`signed in ${input.repair.email}`])
      expect(
        input.succeeds(
          `SELECT s.id=m.space_id, m.role, m.permission
           FROM "user" u JOIN membership m ON m.user_id=u.id JOIN space s ON s.id=m.space_id
           WHERE u.email='${input.repair.email}';`,
        ),
      ).toBe('t|owner|write')
    })

    registerCustomerAuthProof(input.customer)
  })
}
