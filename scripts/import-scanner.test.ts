import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importSpecifiers } from './import-scanner.ts'

const cases = [
  ['static import', `import value from './static.ts'`, './static.ts'],
  ['side-effect import', `import './effect.ts'`, './effect.ts'],
  ['re-export', `export { value } from './exported.ts'`, './exported.ts'],
  ['direct require', `require('./required.ts')`, './required.ts'],
  ['quoted dynamic import', `import('./dynamic.ts')`, './dynamic.ts'],
  ['template-literal dynamic import', 'import(`./template.ts`)', './template.ts'],
  ['concatenated dynamic import', `import('./' + 'joined.ts')`, './joined.ts'],
  ['import.meta.resolve dynamic import', `import(import.meta.resolve('./resolved.ts'))`, './resolved.ts'],
  ['createRequire alias', `const load = createRequire(import.meta.url); load('./loaded.ts')`, './loaded.ts'],
  ['constant indirection', `const target = './indirect.ts'; import(target)`, './indirect.ts'],
] as const

describe('import scanner', () => {
  for (const [name, source, expected] of cases) {
    test(name, () => {
      expect(importSpecifiers(source)).toEqual({ specifiers: [expected], unresolvedRelative: [] })
    })
  }

  test('reports a relative dynamic import that cannot be resolved statically', () => {
    const scan = importSpecifiers('import(`./${moduleName}.ts`)')
    expect(scan.specifiers).toEqual([])
    expect(scan.unresolvedRelative).toHaveLength(1)
  })

  test('a forbidden scanner result is wired through the repository boundary guard', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
    const fixture = mkdtempSync(join(root, '.import-scanner-test-'))
    try {
      mkdirSync(join(fixture, 'scripts'))
      for (const concern of ['orchestrator', 'hub', 'ops', 'local-stack', 'shared']) {
        mkdirSync(join(fixture, concern, 'src'), { recursive: true })
      }
      cpSync(join(root, 'scripts/import-scanner.ts'), join(fixture, 'scripts/import-scanner.ts'))
      cpSync(join(root, 'scripts/check-boundaries.ts'), join(fixture, 'scripts/check-boundaries.ts'))
      cpSync(join(root, 'shared/brand.ts'), join(fixture, 'shared/brand.ts'))
      writeFileSync(join(fixture, 'hub/src/forbidden.ts'), 'void import(`../../orchestrator/src/run.ts`)\n')

      const result = Bun.spawnSync(['bun', join(fixture, 'scripts/check-boundaries.ts')], {
        cwd: fixture, stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('cross-concern')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
