import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideHostedMemory, HOSTED_API_MEMORY_FLOOR_MB } from './check-hosted-memory.ts'

const path = 'orchestrator/deploy/api/fly.toml'

test('refuses 512mb against a 1024mb floor', () => {
  expect(decideHostedMemory({ path, text: '[[vm]]\nmemory = "512mb"', floorMb: 1024 })).toEqual([
    `${path}: memory value "512mb" is below the 1024mb floor; raise it to at least 1024mb; lowering the floor is an operator ruling in scripts/check-hosted-memory.ts`,
  ])
})

test('accepts gigabytes and integer megabytes', () => {
  expect(decideHostedMemory({ path, text: '[[vm]]\nmemory = "1gb"', floorMb: 1024 })).toEqual([])
  expect(decideHostedMemory({ path, text: '[[vm]]\nmemory = 1024', floorMb: 1024 })).toEqual([])
})

test('refuses a missing memory key', () => {
  expect(decideHostedMemory({ path, text: '[[vm]]\ncpus = 1', floorMb: 1024 })).toEqual([
    `${path}: memory is not pinned and the deploy would use Fly's default; set memory = "1024mb" under [[vm]]`,
  ])
})

test('tracked hosted API config meets the ruled floor', () => {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  expect(
    decideHostedMemory({
      path,
      text: readFileSync(resolve(root, path), 'utf8'),
      floorMb: HOSTED_API_MEMORY_FLOOR_MB,
    }),
  ).toEqual([])
})
