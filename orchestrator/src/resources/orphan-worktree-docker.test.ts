import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import type { UnattributableDockerResource } from './docker-resources.ts'
import {
  isOrphanWorktreeDockerResource,
  teardownOrphanWorktreeDockerResources,
} from './orphan-worktree-docker.ts'

afterEach(() => {
  mock.restore()
})

const projectPath = '/projects/example'
const workingDir = `${projectPath}/.claude/worktrees/DEV-1053-change`

function facts(
  overrides: Partial<Parameters<typeof isOrphanWorktreeDockerResource>[0]> = {},
): Parameters<typeof isOrphanWorktreeDockerResource>[0] {
  return {
    workingDir,
    projectPath,
    directoryExists: false,
    gitWorktreePaths: [],
    mainCheckoutPaths: [projectPath],
    registeredMainCheckout: false,
    ...overrides,
  }
}

test('a worktree directory that is gone and unlisted is orphaned', () => {
  expect(isOrphanWorktreeDockerResource(facts())).toBeTrue()
})

test('a worktree directory that is present remains report-only', () => {
  expect(isOrphanWorktreeDockerResource(facts({ directoryExists: true }))).toBeFalse()
})

test('a worktree still listed by git is kept', () => {
  expect(isOrphanWorktreeDockerResource(facts({ gitWorktreePaths: [workingDir] }))).toBeFalse()
})

test('a registered main checkout is kept', () => {
  expect(isOrphanWorktreeDockerResource(facts({ registeredMainCheckout: true }))).toBeFalse()
})

test('a directory outside every registered worktrees root is unchanged', () => {
  expect(
    isOrphanWorktreeDockerResource(facts({ workingDir: '/projects/other/checkout' })),
  ).toBeFalse()
})

test('an unascertainable directory or git inventory remains report-only', () => {
  expect(isOrphanWorktreeDockerResource(facts({ directoryExists: null }))).toBeFalse()
  expect(isOrphanWorktreeDockerResource(facts({ gitWorktreePaths: null }))).toBeFalse()
})

test('orphan teardown removes the whole stack in dependency order', () => {
  const resources = [
    resource('volume', 'stack_data'),
    resource('container', 'stack-database'),
    resource('network', 'stack_default'),
  ]
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result()
  }) as typeof Bun.spawnSync)

  const teardown = teardownOrphanWorktreeDockerResources(resources, [projectPath], () => true)

  expect(teardown.complete).toBeTrue()
  expect(commands).toEqual([
    'docker rm -f stack-database',
    'docker network rm stack_default',
    'docker volume rm stack_data',
  ])
  expect(teardown.removed.map(({ name }) => name)).toEqual([
    'stack-database',
    'stack_default',
    'stack_data',
  ])
})

test('orphan teardown rechecks absence and preserves main-checkout resources', () => {
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result()
  }) as typeof Bun.spawnSync)

  const reappeared = teardownOrphanWorktreeDockerResources(
    [resource('container', 'stack-database')],
    [projectPath],
    () => false,
  )
  const main = teardownOrphanWorktreeDockerResources(
    [resource('container', 'main-database', projectPath)],
    [projectPath],
    () => true,
  )

  expect(reappeared.skipped).toBeTrue()
  expect(main.errors).toEqual(['refused to remove main-checkout Docker resource main-database'])
  expect(commands).toEqual([])
})

function resource(
  kind: UnattributableDockerResource['kind'],
  name: string,
  directory = workingDir,
): UnattributableDockerResource {
  return {
    kind,
    name,
    reason: 'unattributable',
    workingDir: directory,
    composeProject: 'stack',
    mainCheckout: directory === projectPath,
  }
}

function result(): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
