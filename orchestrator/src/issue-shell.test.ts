import { describe, expect, test } from 'bun:test'
import { filedIssueCommandPlan } from './issue-shell.ts'

describe('filed issue command confinement', () => {
  test('denies secrets and live stores without carrying the coordinator environment', () => {
    const plan = filedIssueCommandPlan({
      command: 'bun run check',
      worktree: '/trees/DEV-392',
      sandboxHome: '/tmp/issue-home',
      path: '/usr/bin:/bin',
      lang: 'en_US.UTF-8',
      operatorEnvPath: '/Users/operator/.claude/.env',
      secretPaths: ['/project/.env', '/keys/token'],
      liveOrchStore: '/platform/orchestrator/orch.db',
      liveHubStore: '/platform/hub/hub.db',
      workerEnvironment: { ORCH_RUN_ID: '41' },
    })

    expect(plan.argv).toEqual(['sh', '-lc', 'bun run check'])
    expect(plan.profile.filesystem.allowWrite).toEqual(['/trees/DEV-392', '/tmp/issue-home'])
    expect(plan.profile.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        '/project/.env',
        '/keys/token',
        '/Users/operator/.claude/.env',
        '/platform/orchestrator/orch.db',
        '/platform/orchestrator',
        '/platform/hub/hub.db',
        '/platform/hub',
      ]),
    )
    expect(plan.env).toEqual({
      ORCH_RUN_ID: '41',
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/issue-home',
      LANG: 'en_US.UTF-8',
    })
    expect(plan.env).not.toHaveProperty('UNRELATED_COORDINATOR_VALUE')
  })
})
