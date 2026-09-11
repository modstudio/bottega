/** Releases direct-child fixtures provisioned by the frozen transport test file. */
import { afterEach, beforeEach } from 'bun:test'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../test/fixture.ts'

let priorChildren = new Set<string>()

beforeEach(() => {
  priorChildren = new Set(readdirSync(dir))
})

afterEach(() => {
  for (const child of readdirSync(dir)) {
    if (!priorChildren.has(child)) rmSync(join(dir, child), { recursive: true, force: true })
  }
})
