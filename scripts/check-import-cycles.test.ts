import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findImportCycles } from './check-import-cycles.ts'

test('finds a synthetic production import cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-import-cycles-'))
  writeFileSync(join(root, 'alpha.ts'), "import './beta.ts'\n")
  writeFileSync(join(root, 'beta.ts'), "import type { Gamma } from './gamma.ts'\nexport type Beta = Gamma\n")
  writeFileSync(join(root, 'gamma.ts'), "export { value } from './alpha.ts'\n")

  expect(findImportCycles(root)).toEqual([
    ['alpha.ts', 'beta.ts', 'gamma.ts', 'alpha.ts'],
  ])
})
