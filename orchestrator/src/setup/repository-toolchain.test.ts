import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configDocumentSchema } from '../recipe/recipe-schema.ts'
import { DEFAULT_PROJECT_CONFIG_PATH } from '../worktree/worktree-lifecycle.ts'
import { detectRepositoryToolchain } from './repository-toolchain.ts'
import { INFERRED_RECIPE_PATH, inferredRecipeContent, proposedGate } from './setup-toolchain.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-toolchain-'))
  roots.push(root)
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), source)
  }
  return root
}

const cases = [
  {
    name: 'Next.js with Prisma (pnpm)',
    files: {
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10',
        scripts: { lint: 'next lint', typecheck: 'tsc --noEmit', test: 'vitest' },
        dependencies: { next: 'latest', '@prisma/client': 'latest' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      '.github/workflows/ci.yml': 'run: pnpm test',
    },
    expected: {
      packageManager: 'pnpm',
      lint: 'pnpm lint',
      typecheck: 'pnpm typecheck',
      test: 'pnpm test',
      ci: true,
      install: ['pnpm', 'install', '--frozen-lockfile'],
    },
  },
  {
    name: 'Rails',
    files: { 'Gemfile.lock': 'rails', Makefile: 'lint:\n\tbin/rubocop\ntest:\n\tbin/rails test\n' },
    expected: {
      packageManager: 'bundler',
      lint: 'make lint',
      typecheck: null,
      test: 'make test',
      ci: false,
      install: ['bundle', 'install'],
    },
  },
  {
    name: 'Laravel',
    files: {
      'composer.lock': '{}',
      'composer.json': JSON.stringify({ scripts: { analyse: 'phpstan analyse', test: 'phpunit' } }),
    },
    expected: {
      packageManager: 'composer',
      lint: 'composer analyse',
      typecheck: null,
      test: 'composer test',
      ci: false,
      install: ['composer', 'install'],
    },
  },
  {
    name: 'Django with uv',
    files: {
      'uv.lock': '',
      'pyproject.toml': '[tool.ruff]\n[dependency-groups]\ndev=["pytest"]\n',
    },
    expected: {
      packageManager: 'uv',
      lint: 'uv run ruff check .',
      typecheck: null,
      test: 'uv run pytest',
      ci: false,
      install: ['uv', 'sync', '--frozen'],
    },
  },
  {
    name: 'Go service',
    files: { 'go.mod': 'module example.test/service\n' },
    expected: {
      packageManager: 'go',
      lint: 'go vet ./...',
      typecheck: null,
      test: 'go test ./...',
      ci: false,
      install: ['go', 'mod', 'download'],
    },
  },
  {
    name: 'plain bun library',
    files: { 'bun.lock': '', 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }) },
    expected: {
      packageManager: 'bun',
      lint: null,
      typecheck: null,
      test: 'bun run test',
      ci: false,
      install: ['bun', 'install', '--frozen-lockfile'],
    },
  },
  {
    name: 'npm placeholder test',
    files: {
      'package-lock.json': '{}',
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    },
    expected: {
      packageManager: 'npm',
      lint: null,
      typecheck: null,
      test: null,
      ci: false,
      install: ['npm', 'ci'],
    },
  },
] as const

for (const entry of cases) {
  test(`detects and proposes ${entry.name}`, async () => {
    const facts = await detectRepositoryToolchain(fixture(entry.files))
    expect(facts).toMatchObject({
      packageManager: entry.expected.packageManager,
      lint: entry.expected.lint,
      typecheck: entry.expected.typecheck,
      test: entry.expected.test,
      ci: entry.expected.ci,
    })
    expect(proposedGate(facts)).toBe(
      [entry.expected.lint, entry.expected.typecheck, entry.expected.test]
        .filter(Boolean)
        .join(' && ') || null,
    )
    const content = inferredRecipeContent(facts)
    expect(content).not.toBeNull()
    const parsed = configDocumentSchema.parse(Bun.JSONC.parse(content!))
    expect(parsed.worktree?.create[0]?.run).toEqual({
      command: entry.expected.install[0],
      args: entry.expected.install.slice(1),
    })
  })
}

test('distinguishes the auto-discovered default config from the inferred recipe', async () => {
  const root = fixture({
    'package.json': JSON.stringify({ packageManager: 'bun@1.3.1' }),
    'bun.lock': '',
    [DEFAULT_PROJECT_CONFIG_PATH]: '{}',
    [INFERRED_RECIPE_PATH]: '{}',
  })
  expect(await detectRepositoryToolchain(root)).toMatchObject({
    defaultConfigExists: true,
    inferredRecipeFile: { status: 'regular', content: '{}', reason: null },
  })
})

test('recognizes a nested Ruff table as Ruff configuration', async () => {
  const root = fixture({
    'uv.lock': '',
    'pyproject.toml': '[tool.ruff.lint]\nselect = ["E"]\n',
  })
  expect((await detectRepositoryToolchain(root)).lint).toBe('uv run ruff check .')
})

test('marks a symlinked inferred recipe path unsafe without reading outside', async () => {
  const root = fixture({ 'bun.lock': '', 'package.json': '{"packageManager":"bun@1"}' })
  const outside = mkdtempSync(join(tmpdir(), 'setup-toolchain-outside-'))
  roots.push(outside)
  writeFileSync(join(outside, 'worktree-recipe.jsonc'), 'outside')
  symlinkSync(outside, join(root, dirname(INFERRED_RECIPE_PATH)))
  expect(await detectRepositoryToolchain(root)).toMatchObject({
    inferredRecipeFile: { status: 'unsafe', content: null },
  })
})
