import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closureFromMetafile, workspaceExternals } from './release-entry-closure.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('closureFromMetafile', () => {
  test('keeps repository inputs and drops inputs outside the repository', () => {
    const root = join(tmpdir(), 'release-closure-root')
    const closure = closureFromMetafile(
      root,
      root,
      { inputs: { 'a.ts': {}, 'src/b.ts': {}, '../outside.ts': {} } },
      new Set(),
    )
    expect(closure).toEqual(new Set(['a.ts', 'src/b.ts']))
  })

  test('refuses an externalized workspace import and names both sides', () => {
    expect(() =>
      closureFromMetafile(
        '/repo',
        '/repo',
        {
          inputs: {
            'a.ts': { imports: [{ path: '@scope/pkg/sub', external: true }] },
          },
        },
        new Set(['@scope/pkg']),
      ),
    ).toThrow('workspace import @scope/pkg/sub from a.ts was externalized')
  })

  test('allows an externalized third-party import', () => {
    expect(
      closureFromMetafile(
        '/repo',
        '/repo',
        { inputs: { 'a.ts': { imports: [{ path: 'zod', external: true }] } } },
        new Set(['@scope/pkg']),
      ),
    ).toEqual(new Set(['a.ts']))
  })
})

test('workspaceExternals maps workspace names and excludes them from externals', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-workspaces-'))
  fixtures.push(root)
  mkdirSync(join(root, 'packages', 'shared'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      workspaces: ['packages/shared'],
      dependencies: { '@scope/shared': 'workspace:*', zod: '1' },
      devDependencies: { typescript: '1' },
    }),
  )
  writeFileSync(
    join(root, 'packages', 'shared', 'package.json'),
    JSON.stringify({
      name: '@scope/shared',
      peerDependencies: { react: '1' },
      optionalDependencies: { optional: '1' },
    }),
  )

  expect(workspaceExternals(root)).toEqual({
    names: new Map([['@scope/shared', 'packages/shared']]),
    externals: ['zod', 'typescript', 'react', 'optional'],
  })
})
