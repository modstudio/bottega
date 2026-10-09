import { describe, expect, test } from 'bun:test'
import {
  callerCheckoutDecision,
  dispatchLaunchCwdDecision,
  resolveCallerCheckoutDecision,
  taskBranchLandingBypassWarning,
} from './dispatch-cli-service.ts'

describe('dispatch launch cwd selection', () => {
  test('repo-path mutation: --repo without --cwd launches from the named project', () => {
    expect(
      dispatchLaunchCwdDecision({
        namedProject: { name: 'starship', path: '/projects/starship' },
        cwdWasGiven: false,
        cwd: '/projects/atlas',
        cwdProject: { name: 'atlas' },
      }),
    ).toEqual({ checkoutCwd: '/projects/starship', refusal: null })
  })

  test('project-match mutation: --repo and --cwd in different projects are refused', () => {
    const decision = dispatchLaunchCwdDecision({
      namedProject: { name: 'starship', path: '/projects/starship' },
      cwdWasGiven: true,
      cwd: '/projects/atlas/.claude/worktrees/DEV-1227',
      cwdProject: { name: 'atlas' },
    })

    expect(decision).toEqual({
      refusal:
        '--repo names project starship, but --cwd is inside project atlas; drop one of --repo or --cwd, or point --cwd inside project starship',
    })
  })

  test('worktree-path mutation: --repo accepts --cwd inside the named project', () => {
    for (const cwd of ['/projects/starship', '/projects/starship/.claude/worktrees/STAR-42']) {
      expect(
        dispatchLaunchCwdDecision({
          namedProject: { name: 'starship', path: '/projects/starship' },
          cwdWasGiven: true,
          cwd,
          cwdProject: { name: 'starship' },
        }),
      ).toEqual({ checkoutCwd: cwd, refusal: null })
    }
  })

  test('unregistered-caller mutation: --repo ignores an unregistered caller without --cwd', () => {
    expect(
      dispatchLaunchCwdDecision({
        namedProject: { name: 'starship', path: '/projects/starship' },
        cwdWasGiven: false,
        cwd: '/tmp/outside',
        cwdProject: null,
      }),
    ).toEqual({ checkoutCwd: '/projects/starship', refusal: null })
  })
})

describe('caller checkout resolution', () => {
  const mainCheckoutFacts = {
    repoRoot: '/projects/project',
    registeredProjectPath: '/projects/project',
    linkedWorktree: false,
    borrowedCheckout: false,
  }

  test('same-project-recording mutation: --cwd alone keeps the shell cwd as launch cwd', () => {
    const checked: string[] = []
    const decision = resolveCallerCheckoutDecision(
      {
        shellCwd: '/projects/project',
        explicitCwd: '/projects/project/.claude/worktrees/DEV-1227',
        namedProject: null,
        cwdProject: { name: 'project', path: '/projects/project' },
        shellProject: { name: 'project', path: '/projects/project' },
      },
      (cwd) => {
        checked.push(cwd)
        return mainCheckoutFacts
      },
    )

    expect(checked).toEqual(['/projects/project/.claude/worktrees/DEV-1227'])
    expect(decision).toEqual({
      callerCwd: '/projects/project/.claude/worktrees/DEV-1227',
      launchCwd: '/projects/project',
      notice: null,
    })
  })

  test('cross-project-recording mutation: --repo alone records the named registered path', () => {
    const checked: string[] = []
    const decision = resolveCallerCheckoutDecision(
      {
        shellCwd: '/projects/atlas',
        explicitCwd: null,
        namedProject: { name: 'starship', path: '/projects/starship' },
        cwdProject: null,
        shellProject: { name: 'atlas', path: '/projects/atlas' },
      },
      (cwd) => {
        checked.push(cwd)
        return {
          repoRoot: '/projects/starship',
          registeredProjectPath: '/projects/starship',
          linkedWorktree: false,
          borrowedCheckout: false,
        }
      },
    )

    expect(checked).toEqual(['/projects/starship'])
    expect(decision).toEqual({
      callerCwd: '/projects/starship',
      launchCwd: '/projects/starship',
      notice: null,
    })
  })

  test('durable-recording mutation: --repo with its worktree records the registered path', () => {
    const decision = resolveCallerCheckoutDecision(
      {
        shellCwd: '/projects/atlas',
        explicitCwd: '/projects/starship/.claude/worktrees/STAR-42',
        namedProject: { name: 'starship', path: '/projects/starship' },
        cwdProject: { name: 'starship', path: '/projects/starship' },
        shellProject: { name: 'atlas', path: '/projects/atlas' },
      },
      () => ({
        repoRoot: '/projects/starship',
        registeredProjectPath: '/projects/starship',
        linkedWorktree: true,
        borrowedCheckout: false,
      }),
    )

    expect(decision).toEqual({
      callerCwd: '/projects/starship/.claude/worktrees/STAR-42',
      launchCwd: '/projects/starship',
      notice: null,
    })
  })

  test('implicit-recording mutation: a dispatch with neither flag remains unchanged', () => {
    const decision = resolveCallerCheckoutDecision(
      {
        shellCwd: '/projects/project/packages/app',
        explicitCwd: null,
        namedProject: null,
        cwdProject: null,
        shellProject: { name: 'project', path: '/projects/project' },
      },
      () => mainCheckoutFacts,
    )

    expect(decision).toEqual({
      callerCwd: '/projects/project/packages/app',
      launchCwd: '/projects/project/packages/app',
      notice: null,
    })
  })

  test('shell-cwd mutation: implicit linked worktree resolves to the registered project and warns', () => {
    expect(
      callerCheckoutDecision({
        recordedLaunchCwd: '/project/.claude/worktrees/DEV-780',
        explicitCwd: null,
        repoRoot: '/project',
        registeredProjectPath: '/project',
        linkedWorktree: true,
        borrowedCheckout: false,
      }),
    ).toEqual({
      callerCwd: '/project',
      launchCwd: '/project/.claude/worktrees/DEV-780',
      notice:
        '! dispatched from project tree /project/.claude/worktrees/DEV-780; caller checkout is /project (pass --cwd to choose a tree)',
    })
  })

  test('explicit-cwd mutation: an explicitly selected linked worktree remains selected', () => {
    expect(
      callerCheckoutDecision({
        recordedLaunchCwd: '/elsewhere',
        explicitCwd: '/project/.claude/worktrees/DEV-780',
        repoRoot: '/project',
        registeredProjectPath: '/project',
        linkedWorktree: true,
        borrowedCheckout: false,
      }),
    ).toEqual({
      callerCwd: '/project/.claude/worktrees/DEV-780',
      launchCwd: '/elsewhere',
      notice: null,
    })
  })

  test('registration mutation: an implicit cwd in an unregistered repository is unchanged', () => {
    expect(
      callerCheckoutDecision({
        recordedLaunchCwd: '/unregistered',
        explicitCwd: null,
        repoRoot: '/unregistered',
        registeredProjectPath: null,
        linkedWorktree: false,
        borrowedCheckout: false,
      }),
    ).toEqual({ callerCwd: '/unregistered', launchCwd: '/unregistered', notice: null })
  })

  test('an implicit borrowed clone resolves to the registered project', () => {
    expect(
      callerCheckoutDecision({
        recordedLaunchCwd: '/project/.claude/worktrees/orch-832',
        explicitCwd: null,
        repoRoot: '/project',
        registeredProjectPath: '/project',
        linkedWorktree: false,
        borrowedCheckout: true,
      }),
    ).toEqual({
      callerCwd: '/project',
      launchCwd: '/project/.claude/worktrees/orch-832',
      notice:
        '! dispatched from project tree /project/.claude/worktrees/orch-832; caller checkout is /project (pass --cwd to choose a tree)',
    })
  })
})

describe('task branch landing bypass warning', () => {
  test('refusal-text mutation: explicit base success does not print a refusal', () => {
    const warning = taskBranchLandingBypassWarning('DEV-750', 'feature/DEV-750', {
      action: 'refuse',
      cause: 'unknown',
      reason: 'targeted listing was truncated',
      branch: 'feature/old-DEV-750',
      tip: 'abc123',
    })

    expect(warning).not.toContain('refusing')
    expect(warning).toContain('used as given')
  })

  test('closed-unmerged mutation: an explicit remedy names the withdrawn pull request', () => {
    const warning = taskBranchLandingBypassWarning('DEV-839', 'main', {
      action: 'refuse',
      cause: 'closed-unmerged',
      pullRequest: 413,
      branch: 'DEV-839-old',
      tip: 'abc123',
    })

    expect(warning).toContain('closed-unmerged pull request #413')
    expect(warning).toContain('explicit --base main is used as given')
  })
})
