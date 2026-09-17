import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { expandHome, READONLY_LENS_DENY_PATHS, READONLY_LENS_DENY_SOCKETS } from '../sandbox.ts'
import {
  FILED_ISSUE_COMMAND_TIMEOUT_MS,
  filedIssueCommandPlan,
  filedIssueCommandResult,
  issueRunAsked,
  workerGateEnvironment,
} from './issue-shell.ts'

describe('filed issue command confinement', () => {
  test('denies secrets without carrying the coordinator environment', () => {
    const plan = filedIssueCommandPlan({
      command: 'bun run check',
      worktree: '/trees/DEV-392',
      sandboxHome: '/tmp/issue-home',
      path: '/usr/bin:/bin',
      lang: 'en_US.UTF-8',
      operatorEnvPath: '/Users/operator/.claude/.env',
      secretPaths: ['/project/.env', '/keys/token'],
      workerEnvironment: { ORCH_RUN_ID: '41' },
    })

    expect(plan.argv).toEqual(['sh', '-lc', 'bun run check'])
    expect(plan.profile.network.allowLocalBinding).toBe(true)
    expect(plan.profile.network.allowedDomains).toEqual([])
    expect(plan.profile.filesystem.allowWrite).toEqual(['/trees/DEV-392', '/tmp/issue-home'])
    expect(plan.profile.filesystem.denyRead).toEqual([
      ...READONLY_LENS_DENY_PATHS.map(expandHome).map((path) => resolve(path)),
      ...READONLY_LENS_DENY_SOCKETS,
      '/project/.env',
      '/keys/token',
      '/Users/operator/.claude/.env',
    ])
    expect(plan.env).toEqual({
      ORCH_RUN_ID: '41',
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/issue-home',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/issue-home',
    })
    expect(plan.env).not.toHaveProperty('UNRELATED_COORDINATOR_VALUE')
  })

  test('worker gate environment withholds credentials and SSH_AUTH_SOCK', () => {
    expect(
      workerGateEnvironment({
        PATH: '/bin',
        USER: 'operator',
        SHELL: '/bin/zsh',
        LANG: 'C.UTF-8',
        TERM: 'xterm',
        LC_ALL: 'en_US.UTF-8',
        OPENAI_API_KEY: 'sk-secret',
        SSH_AUTH_SOCK: '/tmp/ssh.sock',
        ORCH_RUN_ID: '41',
        ORCH_GUARDED_GIT_COMMON_DIR: '/repo/.git',
        ORCH_ALLOWED_GIT_REF: 'refs/heads/DEV-1',
        HOME: '/Users/operator',
      }),
    ).toEqual({
      PATH: '/bin',
      USER: 'operator',
      SHELL: '/bin/zsh',
      LANG: 'C.UTF-8',
      TERM: 'xterm',
      LC_ALL: 'en_US.UTF-8',
      ORCH_GUARDED_GIT_COMMON_DIR: '/repo/.git',
      ORCH_ALLOWED_GIT_REF: 'refs/heads/DEV-1',
    })
  })

  test('an asking run or non-done reply is treated as asking', () => {
    expect(issueRunAsked({ status: 'asking' }, { status: 'done', questions: null })).toBe(true)
    expect(issueRunAsked({ status: 'ok' }, { status: 'asking', questions: null })).toBe(true)
    expect(
      issueRunAsked({ status: 'ok' }, { status: 'done', questions: [{ question: 'which?' }] }),
    ).toBe(true)
    expect(issueRunAsked({ status: 'ok' }, { status: 'done', questions: null })).toBe(false)
  })

  test('a timed-out command is a failed result naming the limit', () => {
    expect(
      filedIssueCommandResult({
        exitCode: null,
        stdout: '',
        stderr: '',
        exitedDueToTimeout: true,
      }),
    ).toEqual({
      ok: false,
      text: `timed out after ${FILED_ISSUE_COMMAND_TIMEOUT_MS}ms`,
      exitCode: -1,
    })
  })

  test('a timed-out command names remaining group members when they survive the kill', () => {
    expect(
      filedIssueCommandResult({
        exitCode: null,
        stdout: '',
        stderr: '',
        exitedDueToTimeout: true,
        groupRemains: true,
      }),
    ).toEqual({
      ok: false,
      text: `timed out after ${FILED_ISSUE_COMMAND_TIMEOUT_MS}ms; process group still has members`,
      exitCode: -1,
    })
  })
})
