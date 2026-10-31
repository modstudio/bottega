import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import drizzleConfig from './drizzle.config.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outputDirectory = resolve(root, drizzleConfig.out!)
const outputFiles = readdirSync(outputDirectory, { recursive: true, encoding: 'utf8' })
  .filter((path) => statSync(resolve(outputDirectory, path)).isFile())
  .map((path) => relative(root, resolve(outputDirectory, path)))

function matchesSome(patterns: string[], path: string): boolean {
  return patterns.some(
    (pattern) => new Bun.Glob(pattern).match(path) || new Bun.Glob(`${pattern}/**`).match(path),
  )
}

test('Biome force-excludes every generated Drizzle record file but not migrations', () => {
  const biome = Bun.JSONC.parse(readFileSync(resolve(root, 'biome.jsonc'), 'utf8')) as {
    files: { includes: string[] }
  }
  const forceExclusions = biome.files.includes
    .filter((pattern) => pattern.startsWith('!!'))
    .map((pattern) => pattern.slice(2))
  const generatedFiles = outputFiles.filter(
    (path) => path.endsWith('/snapshot.json') || path.includes('/migrations/meta/'),
  )

  expect(generatedFiles.length).toBeGreaterThan(0)
  for (const path of generatedFiles) {
    expect(matchesSome(forceExclusions, path), path).toBeTrue()
  }
  const metaJournal = relative(root, resolve(outputDirectory, 'meta/_journal.json'))
  expect(matchesSome(forceExclusions, metaJournal), metaJournal).toBeTrue()

  const migrationFiles = outputFiles.filter((path) => path.endsWith('/migration.sql'))
  expect(
    migrationFiles.some((path) => !matchesSome(forceExclusions, path)),
    'at least one migration.sql must remain included',
  ).toBeTrue()
})
