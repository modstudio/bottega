import { describe, expect, test } from 'bun:test'
import { borrowedCheckoutFromAlternates, scrubbedGitEnv } from './git.ts'

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
  test('the shared scrub removes repository-location variables git lists and orch routing, not global-behaviour GIT_*', () => {
    const contaminated: NodeJS.ProcessEnv = {
      UNRELATED: 'preserved',
      GIT_DIR: '/worker/git-dir',
      GIT_WORK_TREE: '/worker/tree',
      GIT_OBJECT_DIRECTORY: '/worker/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
      GIT_INDEX_FILE: '/worker/index',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/worker/hooks',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
      GIT_CONFIG_GLOBAL: '/worker/global-config',
      GIT_CONFIG_SYSTEM: '/worker/system-config',
      GIT_CONFIG_NOSYSTEM: '1',
      ORCH_GUARDED_GIT_COMMON_DIR: '/worker/common',
      ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
    }
    const scrubbed = scrubbedGitEnv(contaminated)
    expect(scrubbed.UNRELATED).toBe('preserved')
    for (const variable of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_INDEX_FILE',
      'GIT_CONFIG_COUNT',
      'ORCH_GUARDED_GIT_COMMON_DIR',
      'ORCH_ALLOWED_GIT_REF',
    ]) {
      expect(scrubbed[variable]).toBeUndefined()
    }
    expect(scrubbed.GIT_CONFIG_GLOBAL).toBe('/worker/global-config')
    expect(scrubbed.GIT_CONFIG_SYSTEM).toBe('/worker/system-config')
    expect(scrubbed.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(scrubbed.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(scrubbed.GIT_CONFIG_VALUE_0).toBe('/worker/hooks')
  })
})
