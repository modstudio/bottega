import { describe, expect, test } from 'bun:test'
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
      expect(importSpecifiers(source)).toEqual({ specifiers: [expected], typeOnlySpecifiers: [], unresolvedRelative: [] })
    })
  }

  test('reports a relative dynamic import that cannot be resolved statically', () => {
    const scan = importSpecifiers('import(`./${moduleName}.ts`)')
    expect(scan.specifiers).toEqual([])
    expect(scan.unresolvedRelative).toHaveLength(1)
  })
})
