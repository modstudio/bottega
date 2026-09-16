import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifiedDockerResources,
  type DockerResource,
  dockerInventoryTimeoutMs,
  dockerNetworkInventory,
  dockerRemovalTimeoutMs,
  dockerRunResource,
  dockerRunResources,
  orchRunLabel,
  orphanedDockerResources,
  runIdFromLabels,
  teardownRunResources,
} from './docker-resources.ts'

afterEach(() => {
  mock.restore()
})

test('the canonical run label round-trips only numeric values', () => {
  expect(orchRunLabel(4242)).toBe('orch.run=4242')
  expect(runIdFromLabels({ 'orch.run': '4242' })).toBe(4242)
  expect(runIdFromLabels(undefined)).toBeNull()
  expect(runIdFromLabels({})).toBeNull()
  expect(runIdFromLabels({ 'orch.run': '' })).toBeNull()
  expect(runIdFromLabels({ 'orch.run': 'run-4242' })).toBeNull()
  expect(runIdFromLabels({ unrelated: '4242' })).toBeNull()
})

test('resource attribution preserves names and gives a valid label precedence', () => {
  expect(dockerRunResource('orch-17')).toEqual({ runId: 17 })
  expect(dockerRunResource('starship_wt_feature', { 'orch.run': '17' })).toEqual({ runId: 17 })
  expect(dockerRunResource('starship_wt_feature')).toBeNull()
  expect(dockerRunResource('orch-17', { 'orch.run': '18' })).toEqual({ runId: 18 })
})

test('container, volume, and network inventory attribute project names from labels', () => {
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format')) return result('starship_wt_feature\t17')
    if (command.startsWith('docker volume ls --format')) return result('stopal_database\t18')
    if (command === 'docker network ls --format {{.Name}}') return result('adanim_default')
    if (command === 'docker network inspect adanim_default') {
      return result(
        JSON.stringify([
          {
            Name: 'adanim_default',
            Labels: { 'orch.run': '19' },
          },
        ]),
      )
    }
    return result('', 1, `unexpected command: ${command}`)
  }) as typeof Bun.spawnSync)

  expect(dockerRunResources()).toEqual({
    ascertainable: true,
    resources: [
      { kind: 'container', name: 'starship_wt_feature', runId: 17 },
      { kind: 'volume', name: 'stopal_database', runId: 18 },
    ],
  })
  expect(dockerNetworkInventory()).toEqual({
    ascertainable: true,
    networks: [
      {
        name: 'adanim_default',
        createdAt: null,
        workingDir: null,
        runId: 19,
      },
    ],
  })
})

test('docker inventory timeout is configurable and defaults to 1s', () => {
  expect(dockerInventoryTimeoutMs({})).toBe(1_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: '4000' })).toBe(4_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: '0' })).toBe(1_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: 'nope' })).toBe(1_000)
  expect(dockerRemovalTimeoutMs({})).toBe(10_000)
  expect(dockerRemovalTimeoutMs({ ORCH_DOCKER_REMOVAL_TIMEOUT_MS: '25000' })).toBe(25_000)
})

test('a timed-out Docker inventory is unascertainable and discards partial rows', () => {
  const prior = process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS = '25'
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    if (args[1] === 'ps') return result('app-orch-41-web')
    return { ...result(''), exitedDueToTimeout: true }
  }) as typeof Bun.spawnSync)
  try {
    expect(dockerRunResources()).toEqual({
      ascertainable: false,
      reason: 'docker volume ls inventory unavailable: timed out after 25ms',
    })
  } finally {
    if (prior === undefined) delete process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
    else process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS = prior
  }
})

test('the default Docker inventory timeout retries once with the longer load bound', () => {
  const prior = process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  delete process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
  const timeouts: number[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: { timeout?: number }) => {
    timeouts.push(options?.timeout ?? 0)
    if (args[1] === 'ps' && timeouts.length === 1) {
      return { ...result(''), exitedDueToTimeout: true }
    }
    return result('')
  }) as typeof Bun.spawnSync)
  try {
    expect(dockerRunResources()).toEqual({ ascertainable: true, resources: [] })
    expect(timeouts).toEqual([1_000, 10_000, 1_000])
  } finally {
    if (prior === undefined) delete process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS
    else process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS = prior
  }
})

test('terminal resources are orphaned even while their worktree survives', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-terminal-resource-'))
  const worktree = join(root, 'orch-41')
  mkdirSync(worktree)
  const resources: DockerResource[] = [
    { kind: 'container', name: 'app-orch-41-web', runId: 41 },
    { kind: 'volume', name: 'app_orch-41_data', runId: 41 },
  ]
  try {
    expect(
      orphanedDockerResources(resources, [{ id: 41, repo: 'app', worktree, status: 'ok' }]),
    ).toEqual(resources.map((resource) => ({ resource, project: 'app' })))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live and asking runs own resources before and after their worktree exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-live-resource-'))
  const worktree = join(root, 'orch-42')
  mkdirSync(worktree)
  const resources: DockerResource[] = [
    { kind: 'container', name: 'app-orch-42-web', runId: 42 },
    { kind: 'volume', name: 'app_orch-43_data', runId: 43 },
  ]
  try {
    expect(
      orphanedDockerResources(resources, [
        { id: 42, repo: 'app', worktree, status: 'running' },
        { id: 43, repo: 'app', worktree: null, status: 'asking' },
      ]),
    ).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run teardown removes only containers, is idempotent, and isolates run identity', () => {
  let containers = ['app-orch-51-web', 'app-orch-52-web']
  let volumes = ['app_orch-51_data', 'app_orch-52_data']
  const removals: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format')) return result(containers.join('\n'))
    if (command.startsWith('docker volume ls --format')) return result(volumes.join('\n'))
    if (command.startsWith('docker ')) removals.push(command)
    if (command === 'docker rm -f app-orch-51-web') containers = containers.slice(1)
    if (command === 'docker volume rm app_orch-51_data') volumes = volumes.slice(1)
    return result('')
  }) as typeof Bun.spawnSync)

  teardownRunResources(51)
  teardownRunResources(51)
  expect(removals).toEqual(['docker rm -f app-orch-51-web'])
})

test('reporting distinguishes leaked resources from terminal resources in a retained tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-retained-report-'))
  const resources: DockerResource[] = [
    { kind: 'container', name: 'app-orch-91-web', runId: 91 },
    { kind: 'volume', name: 'app_orch-92_data', runId: 92 },
  ]
  try {
    expect(
      classifiedDockerResources(resources, [
        { id: 91, repo: 'app', worktree: dir, status: 'ok' },
        { id: 92, repo: 'app', worktree: join(dir, 'gone'), status: 'failed' },
      ]).map(({ condition }) => condition),
    ).toEqual(['retained-worktree-resources', 'leaked'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unavailable inventory prevents teardown of partially inventoried resources', () => {
  const errors: string[] = []
  spyOn(console, 'error').mockImplementation((value) => {
    errors.push(String(value))
  })
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format')) return result('app-orch-61-web')
    if (command.startsWith('docker volume ls --format')) {
      return result('', 1, 'Cannot connect to the Docker daemon')
    }
    return result('', 1, 'Cannot connect to the Docker daemon')
  }) as typeof Bun.spawnSync)

  expect(teardownRunResources(61)).toEqual(
    expect.objectContaining({
      complete: false,
      removed: 0,
      skipped: true,
    }),
  )
  expect(errors).toEqual([
    expect.stringContaining('inventory unavailable: Cannot connect to the Docker daemon'),
  ])
})

test('an already-removed resource is an idempotent success without an error log', () => {
  const errors: string[] = []
  spyOn(console, 'error').mockImplementation((value) => {
    errors.push(String(value))
  })
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format')) return result('app-orch-71-web')
    if (command.startsWith('docker volume ls --format')) return result('')
    return result('', 1, 'Error response from daemon: No such container: app-orch-71-web')
  }) as typeof Bun.spawnSync)

  teardownRunResources(71)
  expect(errors).toEqual([])
})

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
