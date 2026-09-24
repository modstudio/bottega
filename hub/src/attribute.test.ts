import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { attribute, isInjected, keyFromBranch, keyFromWorktree } from './attribute.ts'

beforeAll(resetFixtureStore)

describe('worktree attribution', () => {
  // The fixture carries every worktree shape the attribution has to preserve.
  test.each([
    ['/fixtures/repos/beta/.claude/worktrees/BET-2533', 'BET-2533'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2437', 'BET-2437'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2547', 'BET-2547'],
    ['/fixtures/repos/beta/.claude/worktrees/BET-2548', 'BET-2548'],
    ['/fixtures/repos/alpha/.claude/worktrees/ALP-5347', 'ALP-5347'],
    ['/fixtures/repos/alpha/.claude/worktrees/ALP-5330', 'ALP-5330'],
    ['/fixtures/repos/delta/.claude/worktrees/DEL-708-standings', 'DEL-708'],
    ['/fixtures/repos/delta/.claude/worktrees/worktree-DEL-703-markdown-render', 'DEL-703'],
    // Lowercase, underscores, key in the middle. Anchoring the regex to the
    // start of the directory name would drop exactly this one.
    ['/fixtures/repos/gamma/.claude/worktrees/technical_gam_986_nexus_shell_barrel', 'GAM-986'],
    // A path nested below the worktree root still names its task.
    ['/fixtures/repos/beta/.claude/worktrees/BET-2548/resources/assets/js', 'BET-2548'],
  ])('%s -> %s', (cwd, key) => {
    expect(keyFromWorktree(cwd)).toBe(key)
  })

  test('a plain checkout names no task', () => {
    expect(keyFromWorktree('/fixtures/repos/workshop')).toBeNull()
    expect(keyFromWorktree('/fixtures/repos/beta')).toBeNull()
  })

  test('a prefix inside a word is not a key', () => {
    expect(keyFromWorktree('/fixtures/repos/x/.claude/worktrees/lab-2533')).toBeNull()
  })
})

describe('attribute()', () => {
  test('a worktree beats a commit subject', () => {
    const a = attribute({
      cwd: '/fixtures/repos/beta/.claude/worktrees/BET-2533',
      commitSubjects: ['BET-9999 something else'],
    })
    expect(a).toEqual({ project: 'beta', key: 'BET-2533', via: 'worktree' })
  })

  test('a commit subject beats prompt prose', () => {
    const a = attribute({
      cwd: '/fixtures/repos/alpha',
      commitSubjects: ['ALP-5347 fix the thing'],
      prompts: ['also have a look at ALP-1111'],
    })
    expect(a).toEqual({ project: 'alpha', key: 'ALP-5347', via: 'commit' })
  })

  test('prompt prose is the last resort', () => {
    const a = attribute({ cwd: '/fixtures/repos/alpha', prompts: ['work on ALP-5347 please'] })
    expect(a).toEqual({ project: 'alpha', key: 'ALP-5347', via: 'prompt' })
  })

  test('an injected payload never names a task', () => {
    // A pasted review pack or system reminder quoting a key is not evidence
    // that anyone worked on it.
    const a = attribute({
      cwd: '/fixtures/repos/alpha',
      prompts: ['<system-reminder>see ALP-5347 for context</system-reminder>'],
    })
    expect(a).toEqual({ project: 'alpha', key: null, via: null })
  })

  test("a key from another project's prose is ignored", () => {
    // An alpha session discussing a beta ticket is not time on it.
    const a = attribute({ cwd: '/fixtures/repos/alpha', prompts: ['like we did in BET-2533'] })
    expect(a).toEqual({ project: 'alpha', key: null, via: null })
  })

  test('no key at all is a real answer, not a failure', () => {
    const a = attribute({ cwd: '/fixtures/repos/workshop', prompts: ['refactor the collector'] })
    expect(a).toEqual({ project: 'workshop', key: null, via: null })
  })

  test('a branch name declares its ticket, in every shape the estate uses', () => {
    // Same matcher as a worktree path, because the shapes are the same and for
    // the same reason: `_` is a word character, so an anchored or \\b-guarded
    // pattern silently drops `technical_gam_986_...` while looking correct.
    expect(keyFromBranch('technical/ALP-5362-delete-the-classes', 'alpha')).toBe('ALP-5362')
    expect(keyFromBranch('BET-2533', 'beta')).toBe('BET-2533')
    expect(keyFromBranch('technical_gam_986_nexus_shell_barrel', 'gamma')).toBe('GAM-986')
    // develop is where the main checkouts sit, and it declares nothing.
    expect(keyFromBranch('develop', 'alpha')).toBeNull()
    expect(keyFromBranch(null, 'alpha')).toBeNull()
    // Cross-project chatter is not time spent: same rule prose keys follow.
    expect(keyFromBranch('BET-2533', 'alpha')).toBeNull()
  })

  test('the project never depends on whether a task was identified', () => {
    // The two are decided by different things - the project by the working
    // directory, the task by whatever named it - and the project roll-up must
    // therefore be untouched by any change to task attribution. This is what
    // makes it safe to drop a bad key rather than keep it: the hours stay on
    // the right project, they just stop claiming a task they did not belong to.
    const cwd = '/fixtures/repos/alpha'
    const named = attribute({ cwd, prompts: ['work on ALP-5347 please'] })
    const silent = attribute({ cwd, prompts: ['just make the tests pass'] })
    const worktree = attribute({ cwd: `${cwd}/.claude/worktrees/ALP-5347/app` })
    expect(named.key).not.toBeNull()
    expect(silent.key).toBeNull()
    expect([named.project, silent.project, worktree.project]).toEqual(['alpha', 'alpha', 'alpha'])
  })

  test('a shared key prefix never chooses a project', () => {
    expect(
      attribute({
        cwd: '/fixtures/repos/zeta/.claude/worktrees/SHR-42',
        commitSubjects: ['SHR-42 shared label'],
      }),
    ).toEqual({ project: 'zeta', key: 'SHR-42', via: 'worktree' })
    expect(attribute({ cwd: null, prompts: ['work on SHR-42'] })).toEqual({
      project: null,
      key: 'SHR-42',
      via: 'prompt',
    })
  })
})

describe('injected markers', () => {
  test.each([
    '<system-reminder>anything</system-reminder>',
    '<command-name>/foo</command-name>',
    'This session is being continued from a previous conversation',
    '<task-notification>done</task-notification>',
  ])('%s is injected', (text) => {
    expect(isInjected(text)).toBe(true)
  })

  test('ordinary prose is not', () => {
    expect(isInjected('please fix the failing test in ALP-5347')).toBe(false)
  })
})
