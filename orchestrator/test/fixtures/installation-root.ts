import { afterAll, beforeAll } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dir } from './store.ts'

/** resolveInstallationPaths uses the preload install-home override and needs a platform package.json. */
export function useFixtureInstallationRoot(): void {
  const fixturePackage = join(dir, 'package.json')
  beforeAll(() => writeFileSync(fixturePackage, JSON.stringify({ name: PLATFORM_SLUG })))
  afterAll(() => rmSync(fixturePackage, { force: true }))
}
