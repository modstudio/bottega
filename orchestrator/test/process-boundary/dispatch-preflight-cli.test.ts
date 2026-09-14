import { expect, test, describe } from 'bun:test'
import { chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { worktreeDescribeFixture } from '../fixtures/worktree.ts'
import { db } from '../../src/db.ts'
import { upsertProject } from '../../src/projects.ts'
import { createArgv } from '../../src/worktree-template.ts'

describe('worktree dispatch preflight CLI boundaries', () => {
const { scratchRepo } = worktreeDescribeFixture()
test('preflight lets a legacy create reach worktree creation with its string arguments', () => {
    const { repo } = scratchRepo()
    const capture = join(repo, 'legacy-create-argv')
    const createTool = join(repo, 'legacy-create')
    writeFileSync(createTool, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(capture)}
exit 17
`)
    chmodSync(createTool, 0o755)
    const create = `${createTool} create "{branch}"`
    upsertProject({
      name: 'legacy-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname,
      'do', 'implement', 'inspect', '--follow',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain("the project's worktree tool failed")
    const created = db().query('SELECT id FROM run ORDER BY id DESC LIMIT 1').get() as { id: number }
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      'create', `task/${created.id}`,
    ])
    expect(createArgv(create, { branch: `task/${created.id}` })).toEqual([
      'sh', '-c', `${createTool} create "task/${created.id}"`,
    ])
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before + 1)
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight refuses a structured create missing args before any run row exists', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'malformed-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create: { command: 'scripts/worktree' }, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'do', 'implement', 'inspect',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('worktree.create.args must be an array')
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before)
    rmSync(repo, { recursive: true, force: true })
  })
})
