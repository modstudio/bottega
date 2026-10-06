import { expect, test } from 'bun:test'
import { SOURCE_ROOT_ALLOWANCES, sourceRootViolationLines } from './check-source-root.ts'

const importedRoot = `
import { ROOT } from '../database/db.ts'
import { join } from 'node:path'
export const hook = join(ROOT, 'hooks', 'reference-transaction')
`

test('runtime paths derived from the source root are rejected', () => {
  expect(sourceRootViolationLines(importedRoot, 'orchestrator/src/example.ts')).toEqual([4])
})

test('a named source-only use records its reason', () => {
  expect(SOURCE_ROOT_ALLOWANCES.every((allowance) => allowance.reason.length > 0)).toBe(true)
  expect(
    sourceRootViolationLines(importedRoot, 'fixture.ts', [
      { path: 'fixture.ts', line: 4, reason: 'fixture source-only branch' },
    ]),
  ).toEqual([])
})

test('a direct checkout-relative URL is rejected', () => {
  const source = `
export const hook = fileURLToPath(new URL('../../hooks/example', import.meta.url))
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([2])
})

test('a direct URL without fileURLToPath is rejected', () => {
  const source = `
export const hook = new URL('../../hooks/example', import.meta.url)
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([2])
})

test('an aliased source-root import is rejected by its bound name', () => {
  const source = `
import { ROOT as checkoutRoot } from '../../../database/database-location.ts'
const unrelated = ROOT
export const hook = join(checkoutRoot, 'hooks', 'reference-transaction')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([4])
})

test('a namespace import from a deeper relative path exposes only its ROOT member', () => {
  const source = `
import * as database from '../../../../orchestrator/src/database/db.ts'
const path = database.DB_PATH
export const hook = join(database.ROOT, 'hooks', 'reference-transaction')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([4])
})

test('a shadowing identifier with the same name is not treated as the imported root', () => {
  const source = `
import { ROOT } from '../database/db.ts'
export function example(ROOT: string) {
  return join(ROOT, 'unrelated')
}
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([])
})

test('a local source-root binding is detected under its declared name', () => {
  const source = `
const checkout = fileURLToPath(new URL('../..', import.meta.url))
export const hook = join(checkout, 'hooks', 'reference-transaction')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([3])
})

test('a module-relative createRequire package load is rejected', () => {
  const source = `
import { createRequire } from 'node:module'
const load = createRequire(import.meta.url)
export const schema = load('ajv/dist/2020.js')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([4])
})

test('a module-relative createRequire.resolve package load is rejected', () => {
  const source = `
import { createRequire } from 'node:module'
const load = createRequire(import.meta.url)
export const path = load.resolve('ajv/dist/2020.js')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([4])
})

test('an inline createRequire package load is rejected', () => {
  const source = `
import { createRequire } from 'node:module'
export const schema = createRequire(import.meta.url)('ajv/dist/2020.js')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([3])
})

test('a relative createRequire load is not a package load', () => {
  const source = `
import { createRequire } from 'node:module'
const load = createRequire(import.meta.url)
export const local = load('./ajv-validator.ts')
`
  expect(sourceRootViolationLines(source, 'orchestrator/src/example.ts')).toEqual([])
})

test('a named allowance covers a module-relative package require', () => {
  const source = `
import { createRequire } from 'node:module'
const load = createRequire(import.meta.url)
export const sdk = load.resolve('@agentclientprotocol/sdk')
`
  expect(
    sourceRootViolationLines(source, 'orchestrator/src/example.ts', [
      { path: 'orchestrator/src/example.ts', line: 4, reason: 'ACP SDK presence probe' },
    ]),
  ).toEqual([])
})
