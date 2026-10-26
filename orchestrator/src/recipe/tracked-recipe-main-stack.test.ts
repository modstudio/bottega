import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { stopTrackedTeardownMainStack } from './tracked-recipe-main-stack.ts'

afterEach(() => {
  mock.restore()
})

const COMPOSE_RUNNING_CONTAINERS = ['docker', 'compose', 'ps', '--status', 'running', '-q']
const SERVED_WORKTREE_INVENTORY = [
  'docker',
  'ps',
  '--format',
  '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
]
const WORKTREE_STOP = ['docker', 'compose', 'stop', 'redis']

/** A registered project whose teardown started one main-stack service. */
function stopTeardownMainStack(input: {
  projectName: string
  settings: Project['settings']
}): ReturnType<typeof stopTrackedTeardownMainStack> {
  const recordId = newRecordId()
  const path = `/registered/${input.projectName}`
  db()
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(recordId, input.projectName, path, '{}')
  return stopTrackedTeardownMainStack({
    project: {
      recordId,
      name: input.projectName,
      path,
      stack: null,
      canon: true,
      retiredAt: null,
      settings: input.settings,
    },
    startedServices: ['redis'],
  })
}

function mockDockerPs(inventory: string, calls: string[][]): void {
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return {
      exitCode: 0,
      stdout: Buffer.from(args[0] === 'docker' && args[1] === 'ps' ? inventory : ''),
      stderr: Buffer.from(''),
      success: true,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)
}

test('tracked teardown keeps the main stack while a declared prefix serves a worktree', () => {
  const calls: string[][] = []
  mockDockerPs('starship_wt_star_5773\t/elsewhere/starship', calls)

  const stopped = stopTeardownMainStack({
    projectName: 'fixture-prefix',
    settings: {
      mainStack: { consumers: ['worktree-create'], worktreeComposeProjectPrefix: 'starship_wt_' },
    },
  })

  expect(stopped.failure).toBeNull()
  expect(stopped.note).toContain('a worktree of this project is served')
  expect(calls).toEqual([COMPOSE_RUNNING_CONTAINERS, SERVED_WORKTREE_INVENTORY])
})

test('tracked teardown does not infer a Compose prefix the register never declared', () => {
  const calls: string[][] = []
  mockDockerPs('starship_wt_star_5773\t/elsewhere/starship', calls)

  const stopped = stopTeardownMainStack({
    projectName: 'fixture-no-prefix',
    settings: { mainStack: { consumers: ['worktree-create'] } },
  })

  expect(stopped.failure).toBeNull()
  expect(stopped.note).toBeNull()
  expect(calls).toEqual([COMPOSE_RUNNING_CONTAINERS, SERVED_WORKTREE_INVENTORY, WORKTREE_STOP])
})
