import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { borrowedCheckoutFromAlternates, projectCodeGitEnv, scrubbedGitEnv } from './git.ts'

describe('borrowed checkout identity', () => {
  const objects = '/trees/reader/.git/objects'

  test('accepts one absolute or relative non-bare checkout object store', () => {
    expect(borrowedCheckoutFromAlternates('/projects/app/.git/objects\n', objects)).toBe(
      '/projects/app',
    )
    expect(borrowedCheckoutFromAlternates('../../../main/.git/objects\n', objects)).toBe(
      '/trees/main',
    )
  })

  test('ignores comments but refuses multiple stores, bare stores, and a missing file', () => {
    expect(
      borrowedCheckoutFromAlternates('# shared source\n/projects/app/.git/objects\n', objects),
    ).toBe('/projects/app')
    expect(
      borrowedCheckoutFromAlternates(
        '/projects/one/.git/objects\n/projects/two/.git/objects\n',
        objects,
      ),
    ).toBeNull()
    expect(borrowedCheckoutFromAlternates('/projects/app.git/objects\n', objects)).toBeNull()
    expect(borrowedCheckoutFromAlternates(null, objects)).toBeNull()
  })
})

describe('shared git environment decisions', () => {
  test('the shared scrub removes repository-local variables, config overlays, and ref-guard routing', () => {
    const contaminated: NodeJS.ProcessEnv = {
      UNRELATED: 'preserved',
      GIT_DIR: '/worker/git-dir',
      GIT_WORK_TREE: '/worker/tree',
      GIT_OBJECT_DIRECTORY: '/worker/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
      GIT_INDEX_FILE: '/worker/index',
      GIT_COMMON_DIR: '/worker/common-dir',
      GIT_CONFIG: '/worker/repository-config',
      GIT_CONFIG_PARAMETERS: "'core.filemode'='false'",
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/worker/hooks',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
      GIT_CONFIG_GLOBAL: '/worker/global-config',
      GIT_CONFIG_SYSTEM: '/worker/system-config',
      GIT_CONFIG_NOSYSTEM: '1',
      BOTTEGA_GUARDED_GIT_COMMON_DIR: '/worker/common',
      BOTTEGA_ALLOWED_GIT_REF: 'refs/heads/worker',
    }
    const scrubbed = scrubbedGitEnv(contaminated)
    expect(scrubbed.UNRELATED).toBe('preserved')
    for (const variable of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_CONFIG',
      'GIT_CONFIG_COUNT',
      'BOTTEGA_GUARDED_GIT_COMMON_DIR',
      'BOTTEGA_ALLOWED_GIT_REF',
    ]) {
      expect(scrubbed[variable]).toBeUndefined()
    }
    expect(scrubbed.GIT_CONFIG_COUNT).toBeUndefined()
    expect(scrubbed.GIT_CONFIG_PARAMETERS).toBeUndefined()
    expect(scrubbed.GIT_CONFIG_GLOBAL).toBe('/worker/global-config')
    expect(scrubbed.GIT_CONFIG_SYSTEM).toBe('/worker/system-config')
    expect(scrubbed.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(scrubbed.GIT_CONFIG_KEY_0).toBeUndefined()
    expect(scrubbed.GIT_CONFIG_VALUE_0).toBeUndefined()
    expect(scrubbed.BOTTEGA_GUARDED_GIT_COMMON_DIR).toBeUndefined()
    expect(scrubbed.BOTTEGA_ALLOWED_GIT_REF).toBeUndefined()
  })

  describe('project-code launch environment', () => {
    let previous: string | undefined

    beforeEach(() => {
      previous = process.env.GIT_DIR
      process.env.GIT_DIR = '/lifecycle/hook/git-dir'
    })

    afterEach(() => {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    })

    test('drops local git vars and keeps guard configuration', () => {
      const scrubbed = projectCodeGitEnv({
        ...process.env,
        GIT_INDEX_FILE: '/lifecycle/hook/index',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/guard/hooks',
        BOTTEGA_GUARDED_GIT_COMMON_DIR: '/guard/common',
        BOTTEGA_ALLOWED_GIT_REF: 'refs/heads/run',
      })
      expect(scrubbed.GIT_DIR).toBeUndefined()
      expect(scrubbed.GIT_INDEX_FILE).toBeUndefined()
      expect(scrubbed.GIT_CONFIG_COUNT).toBe('1')
      expect(scrubbed.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
      expect(scrubbed.GIT_CONFIG_VALUE_0).toBe('/guard/hooks')
      expect(scrubbed.BOTTEGA_GUARDED_GIT_COMMON_DIR).toBe('/guard/common')
      expect(scrubbed.BOTTEGA_ALLOWED_GIT_REF).toBe('refs/heads/run')
    })
  })
})
