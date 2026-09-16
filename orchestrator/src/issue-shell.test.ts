import { describe, expect, test } from 'bun:test'
import { filedIssueCommandPlan } from './issue-shell.ts'

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
})
