import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DB_PATH, db } from '../src/db.ts'

test('the preload creates a store and never clears one', () => {
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  expect(preload).not.toMatch(/DELETE FROM/)
  expect(preload).not.toMatch(/TRUNCATE/)
})

test('bun test excludes run artifacts from discovery', () => {
  const bunfig = Bun.TOML.parse(readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8')) as {
    test?: { pathIgnorePatterns?: string[] }
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }
  const unitExclusions = [...pkg.scripts['test:unit']!.matchAll(
    /--path-ignore-patterns\s+(['"])(.*?)\1/g,
  )].map((match) => match[2]!)
  for (const pattern of bunfig.test?.pathIgnorePatterns ?? []) {
    expect(unitExclusions).toContain(pattern)
  }

  const fixture = mkdtempSync(join(tmpdir(), 'orch-runs-ratchet-'))
  const runs = join(fixture, 'runs')
  const marker = `preload-ratchet-${randomUUID()}`
  const nestedDir = join(runs, marker)
  const source = `throw new Error('${marker}')\n`
  mkdirSync(nestedDir, { recursive: true })
  writeFileSync(join(fixture, 'bunfig.toml'), `[test]\npathIgnorePatterns = ${JSON.stringify(bunfig.test?.pathIgnorePatterns ?? [])}\n`)
  writeFileSync(join(fixture, 'control.test.ts'), "import { test } from 'bun:test'; test('control', () => {})\n")
  writeFileSync(join(runs, `${marker}.test.ts`), source)
  writeFileSync(join(nestedDir, `${marker}.test.ts`), source)
  try {
    const commands = {
      unit: ['test', ...unitExclusions.flatMap((pattern) => ['--path-ignore-patterns', pattern])],
      shard: ['test', '--timeout', '30000'],
    }
    for (const [name, args] of Object.entries(commands)) {
      const result = Bun.spawnSync([process.execPath, ...args], {
        cwd: fixture,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = result.stdout.toString() + result.stderr.toString()
      expect({ name, exitCode: result.exitCode, discoveredSentinel: output.includes(marker) }).toEqual({
        name,
        exitCode: 0,
        discoveredSentinel: false,
      })
    }
  } finally {
    rmSync(fixture, { recursive: true })
  }
})

test('the suite runs against a store the preload minted under the temporary directory', () => {
  expect(DB_PATH).toBe(process.env.ORCH_DB)
  expect(realpathSync(DB_PATH).startsWith(realpathSync(tmpdir()))).toBe(true)
  db().query('INSERT INTO session_seen (session_id, last_seen) VALUES (?, ?)').run('preload-test', '2026-09-07T00:00:00.000Z')
})

test('a row written by one test is absent from the next because the store is fresh, not cleared', () => {
  const { n } = db().query('SELECT COUNT(*) AS n FROM session_seen').get() as { n: number }
  expect(n).toBe(0)
})
