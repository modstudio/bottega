import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const inherited = {
  GIT_DIR: '/nonexistent/worker/git-dir',
  GIT_WORK_TREE: '/nonexistent/worker/tree',
  GIT_OBJECT_DIRECTORY: '/nonexistent/worker/objects',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent/worker/alternates',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/nonexistent/worker/hooks',
  ORCH_GUARDED_GIT_COMMON_DIR: '/nonexistent/worker/common',
  ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
} as const

describe('representative production git paths ignore inherited worker routing', () => {
  const previous = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const [key, value] of Object.entries(inherited)) {
      previous.set(key, process.env[key])
      process.env[key] = value
    }
  })

  afterAll(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const rerun = (file: string, name: string) => {
    const p = Bun.spawnSync([
      process.execPath, 'test', new URL(file, import.meta.url).pathname,
      '--test-name-pattern', name,
    ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode, `${p.stdout.toString()}\n${p.stderr.toString()}`).toBe(0)
  }

  test('landing pins resolve in a fixture repository', () => {
    rerun('landing-1.cli.test.ts', 'lands when every lens in a completed review measured the candidate tree')
  })

  test('run checkout observation resolves fixture HEAD', () => {
    rerun('worktree-4.cli.test.ts', 'a real run records an external write and a clean run records none')
  })

  test('review-lens resolves the project tree from an empty directory', () => {
    rerun('review-3.cli.test.ts', 'runs from an empty directory while review-lens still receives the project tree')
  })
})
