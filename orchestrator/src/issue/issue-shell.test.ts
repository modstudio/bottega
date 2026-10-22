import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hubLoginTokenDirectory, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { GATE_COMMAND_TIMEOUT_MS } from '../gate/gate-decision.ts'
import {
  expandHome,
  READONLY_LENS_DENY_PATHS,
  READONLY_LENS_DENY_SOCKETS,
} from '../sandbox/sandbox.ts'
import {
  filedIssueCommandPlan,
  filedIssueCommandResult,
  issueFixReady,
  issueRegisterChangeProven,
  issueRunAsked,
  workerGateEnvironment,
} from './issue-shell.ts'

describe('filed issue command confinement', () => {
  test('denies secrets without carrying the coordinator environment', () => {
    const state = mkdtempSync(join(tmpdir(), 'issue-shell-state-'))
    const environment = { [STATE_HOME_ENV]: state }
    try {
      const plan = filedIssueCommandPlan({
        command: 'bun run check',
        worktree: '/trees/DEV-392',
        sandboxHome: '/tmp/issue-home',
        path: '/usr/bin:/bin',
        lang: 'en_US.UTF-8',
        operatorEnvPaths: ['/Users/operator/.claude/.env', '/Users/operator/config/platform.env'],
        secretPaths: ['/project/.env', '/keys/token'],
        workerEnvironment: { ORCH_RUN_ID: '41' },
        environment,
      })

      expect(plan.argv).toEqual(['sh', '-lc', 'bun run check'])
      expect(plan.profile.network.allowLocalBinding).toBe(true)
      expect(plan.profile.network.allowedDomains).toEqual([])
      expect(plan.profile.filesystem.allowWrite).toEqual(['/trees/DEV-392', '/tmp/issue-home'])
      expect(plan.profile.filesystem.denyRead).toEqual([
        ...READONLY_LENS_DENY_PATHS.map(expandHome).map((path) => resolve(path)),
        hubLoginTokenDirectory(environment),
        ...READONLY_LENS_DENY_SOCKETS,
        '/project/.env',
        '/keys/token',
        '/Users/operator/.claude/.env',
        '/Users/operator/config/platform.env',
      ])
      expect(plan.env).toEqual({
        ORCH_RUN_ID: '41',
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/issue-home',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp/issue-home',
      })
      expect(plan.env).not.toHaveProperty('UNRELATED_COORDINATOR_VALUE')
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
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

  test('fix readiness requires a failing before command and passing after command', () => {
    const fix = {
      status: 'done',
      outcome: 'fixed',
      cause_location: 'orch-code',
      after: 'worker prose',
    }
    const diagnosis = { cause_location: 'orch-code', before: 'different worker prose' }
    const ready = (beforeExit: number, afterExit: number) =>
      issueFixReady(fix, diagnosis, beforeExit, afterExit, true, true, true)

    expect(ready(1, 0)).toBe(true)
    expect(ready(0, 0)).toBe(false)
    expect(ready(1, 1)).toBe(false)
    expect(ready(0, 1)).toBe(false)
  })

  test('each non-reproduction readiness condition still blocks a fix', () => {
    const fix = {
      status: 'done',
      outcome: 'fixed',
      cause_location: 'orch-code',
      after: null,
    }
    const diagnosis = { cause_location: 'orch-code', before: null }
    expect(issueFixReady({ ...fix, status: 'asking' }, diagnosis, 1, 0, true, true, true)).toBe(
      false,
    )
    expect(issueFixReady({ ...fix, outcome: null }, diagnosis, 1, 0, true, true, true)).toBe(false)
    expect(
      issueFixReady({ ...fix, cause_location: 'project-tool' }, diagnosis, 1, 0, true, true, true),
    ).toBe(false)
    expect(issueFixReady(fix, diagnosis, 1, 0, false, true, true)).toBe(false)
    expect(issueFixReady(fix, diagnosis, 1, 0, true, false, true)).toBe(false)
    expect(issueFixReady(fix, diagnosis, 1, 0, true, true, false)).toBe(false)
  })

  test('register proof requires the stated current value and a failing then passing command', () => {
    expect(issueRegisterChangeProven(true, 1, 0)).toBe(true)
    expect(issueRegisterChangeProven(true, 0, 0)).toBe(false)
    expect(issueRegisterChangeProven(true, 1, 1)).toBe(false)
    expect(issueRegisterChangeProven(true, 0, 1)).toBe(false)
    expect(issueRegisterChangeProven(false, 1, 0)).toBe(false)
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
      text: `timed out after ${GATE_COMMAND_TIMEOUT_MS}ms`,
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
      text: `timed out after ${GATE_COMMAND_TIMEOUT_MS}ms; process group still has members`,
      exitCode: -1,
    })
  })
})
