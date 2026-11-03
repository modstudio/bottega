import { expect, test } from 'bun:test'
import { installPathFindings } from './check-install-paths.ts'

test('refuses production paths built from a module directory', () => {
  expect(
    installPathFindings(
      "const root = resolve(import.meta.dir, '../..')\n",
      'orchestrator/src/example.ts',
    ),
  ).toEqual([{ path: 'orchestrator/src/example.ts', line: 1 }])
})

test('allows a module directory passed to an install-root resolver', () => {
  expect(
    installPathFindings(
      'const root = resolveInstallRoot(import.meta.dir, process.env)\n',
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
})

test('ignores test files', () => {
  expect(
    installPathFindings(
      "const root = resolve(import.meta.dir, '../..')\n",
      'orchestrator/src/example.test.ts',
    ),
  ).toEqual([])
})
