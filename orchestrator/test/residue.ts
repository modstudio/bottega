/** Pairs direct-child suite fixtures with the test file that provisions them. */
import { afterEach, beforeEach } from 'bun:test'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from './fixture.ts'

export function releaseSuiteRootChildren(): void {
  let priorChildren = new Set<string>()
  beforeEach(() => { priorChildren = new Set(readdirSync(dir)) })
  afterEach(() => {
    for (const child of readdirSync(dir)) {
      if (!priorChildren.has(child)) rmSync(join(dir, child), { recursive: true, force: true })
    }
  })
}
