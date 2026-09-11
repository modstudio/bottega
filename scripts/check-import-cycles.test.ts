import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findImportCycles } from './check-import-cycles.ts'

let fixtureRoot: string | undefined
afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

test('finds a synthetic production import cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-import-cycles-'))
  fixtureRoot = root
  writeFileSync(join(root, 'alpha.ts'), "import './beta.ts'\n")
  writeFileSync(join(root, 'beta.ts'), "import type { Gamma } from './gamma.ts'\nexport type Beta = Gamma\n")
  writeFileSync(join(root, 'gamma.ts'), "export { value } from './alpha.ts'\n")

  expect(findImportCycles(root)).toEqual([
    ['alpha.ts', 'beta.ts', 'gamma.ts', 'alpha.ts'],
  ])
})
