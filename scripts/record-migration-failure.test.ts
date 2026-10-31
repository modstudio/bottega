import { expect, test } from 'bun:test'
import { CheckFailure, MigrationFailure, phaseFailure } from './record-migration-failure.ts'

const rerun = 'bun scripts/check-record-migrations-apply.ts'

test('gives the install remedy for a pglite module-resolution failure', () => {
  const error = Object.assign(new Error("Cannot find package '@electric-sql/pglite'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  })

  expect(phaseFailure('replaying migrations', error, rerun).message).toBe(
    `replaying migrations failed: Cannot find package '@electric-sql/pglite'. Check that @electric-sql/pglite is installed (bun install), then rerun ${rerun}.`,
  )
})

test('gives the install remedy for any failure while starting pglite', () => {
  expect(phaseFailure('starting PGlite', new Error('startup failed'), rerun).message).toBe(
    `starting PGlite failed: startup failed. Check that @electric-sql/pglite is installed (bun install), then rerun ${rerun}.`,
  )
})

test('preserves a plain proof failure without an install or folder hint', () => {
  const message = 'DEV-1893 jsonb string repair produced ...'
  const failure = phaseFailure('replaying migrations', new Error(message), rerun)

  expect(failure.message).toBe(
    `replaying migrations failed: ${message}. Fix that cause, then rerun ${rerun}.`,
  )
  expect(failure.message).not.toContain('@electric-sql/pglite is installed')
  expect(failure.message).not.toContain('migrations folder is readable')
})

test('returns an existing migration failure unchanged', () => {
  const failure = new MigrationFailure('migration failed with its own remedy')

  expect(phaseFailure('replaying migrations', failure, rerun)).toBe(failure)
})

test('adds the replay phase and remedy to a proof check failure', () => {
  const message = 'DEV-1893 jsonb string repair produced ...'

  expect(phaseFailure('replaying migrations', new CheckFailure(message), rerun).message).toBe(
    `replaying migrations failed: ${message}. Fix that cause, then rerun ${rerun}.`,
  )
})

test('gives only the folder remedy while reading migrations', () => {
  const failure = phaseFailure('reading migrations', new Error('permission denied'), rerun)

  expect(failure.message).toBe(
    `reading migrations failed: permission denied. Check that the migrations folder is readable, then rerun ${rerun}.`,
  )
  expect(failure.message).not.toContain('@electric-sql/pglite is installed')
})
