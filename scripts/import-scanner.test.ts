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
  [
    'import.meta.resolve dynamic import',
    `import(import.meta.resolve('./resolved.ts'))`,
    './resolved.ts',
  ],
  [
    'createRequire alias',
    `const load = createRequire(import.meta.url); load('./loaded.ts')`,
    './loaded.ts',
  ],
  ['constant indirection', `const target = './indirect.ts'; import(target)`, './indirect.ts'],
] as const

describe('import scanner', () => {
  for (const [name, source, expected] of cases) {
    test(name, () => {
      expect(importSpecifiers(source)).toEqual({
        specifiers: [expected],
        typeOnlySpecifiers: [],
        namedImports: name === 're-export' ? [{ specifier: expected, name: 'value' }] : [],
        moduleImports: source.includes('import(') ? [expected] : [],
        unresolvedRelative: [],
      })
    })
  }

  test('reports a relative dynamic import that cannot be resolved statically', () => {
    const scan = importSpecifiers('import(`./${moduleName}.ts`)')
    expect(scan.specifiers).toEqual([])
    expect(scan.unresolvedRelative).toHaveLength(1)
  })

  test('reports the exported names used by a named import', () => {
    expect(importSpecifiers("import { original as alias } from './named.ts'").namedImports).toEqual(
      [{ specifier: './named.ts', name: 'original' }],
    )
  })

  test('reports the exported names used by an export-from declaration', () => {
    expect(importSpecifiers("export { original as alias } from './named.ts'").namedImports).toEqual(
      [{ specifier: './named.ts', name: 'original' }],
    )
  })

  test('reports a namespace import as a whole-module import', () => {
    expect(importSpecifiers("import * as values from './named.ts'").moduleImports).toEqual([
      './named.ts',
    ])
  })

  test('skips type-only imports when reporting private import routes', () => {
    const scan = importSpecifiers("import type * as values from './named.ts'")
    expect(scan.typeOnlySpecifiers).toEqual(['./named.ts'])
    expect(scan.namedImports).toEqual([])
    expect(scan.moduleImports).toEqual([])
  })
})
