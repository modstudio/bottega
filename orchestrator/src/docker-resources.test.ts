import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dockerInventoryTimeoutMs, orphanedDockerResources, teardownRunResources,
  type DockerResource,
} from './docker-resources.ts'
import { AGENTS, db, runJob } from '../test/fixture.ts'

afterEach(() => { mock.restore() })

test('docker inventory timeout is configurable and defaults to 1s', () => {
  expect(dockerInventoryTimeoutMs({})).toBe(1_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: '4000' })).toBe(4_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: '0' })).toBe(1_000)
  expect(dockerInventoryTimeoutMs({ ORCH_DOCKER_INVENTORY_TIMEOUT_MS: 'nope' })).toBe(1_000)
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
    expect(orphanedDockerResources(resources, [
      { id: 41, repo: 'app', worktree, status: 'ok' },
    ])).toEqual(resources.map((resource) => ({ resource, project: 'app' })))
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
    expect(orphanedDockerResources(resources, [
      { id: 42, repo: 'app', worktree, status: 'running' },
      { id: 43, repo: 'app', worktree: null, status: 'asking' },
    ])).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run teardown removes containers before volumes, is idempotent, and isolates run identity', () => {
  let containers = ['app-orch-51-web', 'app-orch-52-web']
  let volumes = ['app_orch-51_data', 'app_orch-52_data']
  const removals: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result(containers.join('\n'))
    if (command === 'docker volume ls --format {{.Name}}') return result(volumes.join('\n'))
    removals.push(command)
    if (command === 'docker rm -f app-orch-51-web') containers = containers.slice(1)
    if (command === 'docker volume rm app_orch-51_data') volumes = volumes.slice(1)
    return result('')
  }) as typeof Bun.spawnSync)

  teardownRunResources(51)
  teardownRunResources(51)
  expect(removals).toEqual([
    'docker rm -f app-orch-51-web',
    'docker volume rm app_orch-51_data',
  ])
})

test('unavailable and failing Docker commands are logged without failing teardown', () => {
  const errors: string[] = []
  spyOn(console, 'error').mockImplementation((value) => { errors.push(String(value)) })
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result('app-orch-61-web')
    if (command === 'docker volume ls --format {{.Name}}') {
      return result('', 1, 'Cannot connect to the Docker daemon')
    }
    return result('', 1, 'Cannot connect to the Docker daemon')
  }) as typeof Bun.spawnSync)

  expect(() => teardownRunResources(61)).not.toThrow()
  expect(errors).toEqual(expect.arrayContaining([
    expect.stringContaining('inventory unavailable: Cannot connect to the Docker daemon'),
    expect.stringContaining('docker rm -f app-orch-61-web failed: Cannot connect to the Docker daemon'),
  ]))
})

test('an already-removed resource is an idempotent success without an error log', () => {
  const errors: string[] = []
  spyOn(console, 'error').mockImplementation((value) => { errors.push(String(value)) })
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result('app-orch-71-web')
    if (command === 'docker volume ls --format {{.Name}}') return result('')
    return result('', 1, 'Error response from daemon: No such container: app-orch-71-web')
  }) as typeof Bun.spawnSync)

  teardownRunResources(71)
  expect(errors).toEqual([])
})

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr),
    success: exitCode === 0, exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('run lifecycle tears resources down only after persisting terminal status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-terminal-teardown-'))
  const agentScript = join(root, 'agent.ts')
  writeFileSync(agentScript, "console.log(JSON.stringify({ answer: 'finished' }))\n")

  const dockerLog: string[] = []
  let teardownId: number | null = null
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: Parameters<typeof Bun.spawnSync>[1]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') {
      const row = db().query("SELECT id FROM run WHERE label='docker-lifecycle-test'").get() as
        { id: number } | null
      teardownId = row?.id ?? null
      return result(teardownId === null ? '' : `app-orch-${teardownId}-web`)
    }
    if (command === 'docker volume ls --format {{.Name}}') return result('')
    if (command.startsWith('docker ')) {
      const row = db().query('SELECT status FROM run WHERE id=?').get(teardownId) as { status: string }
      dockerLog.push(`${row.status}:${command}`)
      return result('')
    }
    return originalSpawnSync(args, options as never)
  }) as typeof Bun.spawnSync)

  const agent = AGENTS.codex!
  const original = { bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut }
  const priorDepth = process.env.ORCH_DEPTH
  agent.bin = process.execPath
  agent.argv = () => [agentScript]
  agent.readsOut = false
  process.env.ORCH_DEPTH = '0'
  try {
    const completed = await runJob({
      job: 'summarize', prompt: 'summarize this', agent: 'codex', noFailover: true,
      label: 'docker-lifecycle-test',
    })
    expect(db().query('SELECT status FROM run WHERE id=?').get(completed.id)).toEqual({ status: 'ok' })
    expect(Number(teardownId)).toBe(completed.id)
    expect(dockerLog).toEqual([`ok:docker rm -f app-orch-${completed.id}-web`])
  } finally {
    agent.bin = original.bin
    agent.argv = original.argv
    agent.readsOut = original.readsOut
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH = priorDepth
    rmSync(root, { recursive: true, force: true })
  }
})
