import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import {
  commentFindingsInSources,
  commentParserExtractionRoot,
  trackedCommentFindings,
} from './check-comment-extraction.ts'
import { commentParserAssets } from './check-comment-parser-assets.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  registerEmbeddedAssets(null)
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const manifest = {
  name: PLATFORM_NAME,
  version: '1.2.3',
  built: '2026-10-30T12:00:00.000Z',
  commit: 'abcdef1234567890',
} as const

function registerFixtureManifest(): void {
  registerEmbeddedAssets({
    assets: {},
    files: Object.fromEntries(
      commentParserAssets('linux-arm64').map(({ packagePath, language }) => [
        packagePath,
        `/embedded/${language}/parser.so`,
      ]),
    ),
    manifest,
  })
}

function git(root: string, ...argv: string[]): void {
  const result = spawnFixtureGitSync(argv, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

describe('tracked comment extraction', () => {
  test('built-in TypeScript parsing does not register a dynamic language', () => {
    const findings = commentFindingsInSources(
      [{ file: 'fixture.ts', source: '// DEV-12\n' }],
      { taskKeyPrefixes: ['DEV'] },
      {
        registerLanguages() {
          throw new Error('dynamic registration must not run')
        },
      },
    )

    expect(findings.map(({ match }) => match)).toEqual(['DEV-12'])
  })

  test('a distribution parser failure names the language and platform without bun install', () => {
    registerFixtureManifest()
    expect(() =>
      commentFindingsInSources(
        [{ file: 'fixture.py', source: '# DEV-12\n' }],
        { taskKeyPrefixes: ['DEV'] },
        {
          registerLanguages() {
            throw new Error('fixture parser failure')
          },
          installKind: () => 'distribution',
          platform: 'linux',
          arch: 'arm64',
          resolveFile: () => undefined,
        },
      ),
    ).toThrow('python comment parser for linux/arm64 from the distribution install')
    try {
      commentFindingsInSources(
        [{ file: 'fixture.py', source: '# DEV-12\n' }],
        { taskKeyPrefixes: ['DEV'] },
        {
          registerLanguages() {
            throw new Error('fixture parser failure')
          },
          installKind: () => 'distribution',
          platform: 'linux',
          arch: 'arm64',
          resolveFile: () => undefined,
        },
      )
    } catch (error) {
      expect(String(error)).not.toContain('bun install')
      expect(String(error)).toContain('update to a release that does')
    }
  })

  test('a checkout parser failure recommends installing checkout dependencies', () => {
    expect(() =>
      commentFindingsInSources(
        [{ file: 'fixture.py', source: '# DEV-12\n' }],
        { taskKeyPrefixes: ['DEV'] },
        {
          registerLanguages() {
            throw new Error('fixture parser failure')
          },
          installKind: () => 'checkout',
          platform: 'linux',
          arch: 'arm64',
        },
      ),
    ).toThrow('run bun install in the checkout and retry')
  })

  test('embedded parsers extract beneath state or run scratch and register those paths', () => {
    registerFixtureManifest()
    for (const useScratch of [false, true]) {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'comment-parser-runtime-'))
      fixtureRoots.push(fixtureRoot)
      const stateRoot = join(fixtureRoot, 'state')
      const scratchRoot = join(fixtureRoot, 'scratch')
      const environment = {
        BOTTEGA_STATE_HOME: stateRoot,
        ...(useScratch ? { BOTTEGA_SCRATCH: scratchRoot } : {}),
      }
      const expectedRoot = join(
        useScratch ? scratchRoot : stateRoot,
        'runtime',
        manifest.version,
        'comment-parsers',
      )
      let registrations: Record<string, { libraryPath: string }> | undefined

      expect(commentParserExtractionRoot(environment, manifest.version)).toBe(expectedRoot)
      expect(() =>
        commentFindingsInSources(
          [{ file: 'fixture.py', source: '# DEV-12\n' }],
          { taskKeyPrefixes: ['DEV'] },
          {
            environment,
            platform: 'linux',
            arch: 'arm64',
            resolveFile: (relativePath) => `/embedded/${relativePath}`,
            readFile: (path) => Buffer.from(`fixture parser bytes for ${path}`),
            registerLanguages(value) {
              registrations = value
              throw new Error('stop after registration')
            },
          },
        ),
      ).toThrow('stop after registration')

      const parserPath = join(expectedRoot, 'python', 'parser.so')
      expect(existsSync(parserPath)).toBe(true)
      expect(readFileSync(parserPath, 'utf8')).toContain('fixture parser bytes')
      expect(registrations?.python?.libraryPath).toBe(parserPath)
    }
  })

  test('skips an unstaged deletion and judges the remaining tracked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'comment-extraction-'))
    fixtureRoots.push(root)
    git(root, 'init', '-b', 'main')
    writeFileSync(join(root, 'deleted.ts'), '// DEV-1\n')
    writeFileSync(join(root, 'remaining.ts'), '// DEV-2\n')
    git(root, 'add', 'deleted.ts', 'remaining.ts')
    unlinkSync(join(root, 'deleted.ts'))

    const findings = trackedCommentFindings(root, { taskKeyPrefixes: ['DEV'] })

    expect(findings.map(({ file, match }) => ({ file, match }))).toEqual([
      { file: 'remaining.ts', match: 'DEV-2' },
    ])
  })
})
