import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

function check(source: string) {
  const fixture = mkdtempSync(join(root, '.evidence-boundary-test-'))
  mkdirSync(join(fixture, 'scripts'))
  mkdirSync(join(fixture, 'orchestrator/src'), { recursive: true })
  cpSync(join(root, 'scripts/import-scanner.ts'), join(fixture, 'scripts/import-scanner.ts'))
  cpSync(join(root, 'scripts/check-evidence-boundary.ts'), join(fixture, 'scripts/check-evidence-boundary.ts'))
  writeFileSync(join(fixture, 'orchestrator/src/evidence.ts'), source)
  const result = Bun.spawnSync(['bun', join(fixture, 'scripts/check-evidence-boundary.ts')], {
    cwd: fixture, stdout: 'pipe', stderr: 'pipe', })
  rmSync(fixture, { recursive: true, force: true })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

describe('evidence boundary guard', () => {
  const forbiddenImports = [
    ['renamed binding', "import { db as connection } from './db.ts'\nconst z = () => connection()\n"],
    ['namespace binding', "import * as persistence from './db.ts'\nconst z = () => persistence.db()\n"],
    ['side-effect import', "import './db.ts'\n"],
    ['dynamic import through a constant', "const target = './db.ts'\nconst z = () => import(target)\n"],
    ['require through a renamed binding', "const connection = require('./db.ts').db\nconnection()\n"],
  ] as const

  for (const [name, source] of forbiddenImports) {
    test(`rejects ${name}`, () => {
      const result = check(source)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('imports "./db.ts" (database access)')
    })
  }

  test('rejects an unresolved computed relative import', () => {
    const result = check("const z = (name: string) => import(`./${name}.ts`)\n")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('unresolved relative import')
  })

  test('documents that a statically named proxy module remains outside this file-level guard', () => {
    const result = check("import { connection } from './persistence.ts'\nconst z = () => connection()\n")
    expect(result.exitCode).toBe(0)
  })
})
