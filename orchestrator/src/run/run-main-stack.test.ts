import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { upsertProject } from '../project/projects.ts'
import { run } from './run.ts'

const repositories: string[] = []
afterEach(() => {
  mock.restore()
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true })
})

test('a foreground repository run ensures its declared MCP stack before probing', async () => {
  const repository = fixtureRepository()
  upsertProject({
    name: 'foreground-mcp-stack-fixture',
    path: repository,
    settings: { mainStack: { consumers: ['mcp'], requiredServices: ['db'] } },
  })
  const originalSpawnSync = Bun.spawnSync
  const dockerCalls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: object) => {
    if (args[0] !== 'docker') return originalSpawnSync(args, options as never)
    dockerCalls.push(args)
    return {
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('daemon unavailable'),
      success: false,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)

  await expect(
    run({
      job: 'review-lens',
      prompt: 'MCP stack foreground fixture',
      agent: 'codex',
      cwd: repository,
      mcp: true,
      lens: 'correctness',
    }),
  ).rejects.toThrow('daemon unavailable')
  expect(dockerCalls.filter((call) => call[1] === 'compose')).toEqual([
    ['docker', 'compose', 'ps', '--status', 'running', '--services', 'db'],
  ])
})

test('a cwd-discovered MCP run ensures its declared stack before the worker-tree probe', async () => {
  const repository = fixtureRepository()
  upsertProject({
    name: 'deferred-mcp-stack-fixture',
    path: repository,
    settings: { mainStack: { consumers: ['mcp'], requiredServices: ['db'] } },
  })
  const originalSpawnSync = Bun.spawnSync
  const dockerCalls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: object) => {
    if (args[0] !== 'docker') return originalSpawnSync(args, options as never)
    dockerCalls.push(args)
    return {
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('daemon unavailable'),
      success: false,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)

  await expect(
    run({
      job: 'review-lens',
      prompt: 'deferred MCP stack fixture',
      agent: 'grok',
      cwd: repository,
      mcp: true,
      lens: 'correctness',
    }),
  ).rejects.toThrow('daemon unavailable')
  expect(dockerCalls.filter((call) => call[1] === 'compose')).toEqual([
    ['docker', 'compose', 'ps', '--status', 'running', '--services', 'db'],
  ])
})

function fixtureRepository(): string {
  const repository = mkdtempSync(join(dir, 'mcp-stack-repo-'))
  repositories.push(repository)
  writeFileSync(join(repository, 'fixture.txt'), 'fixture\n')
  for (const args of [
    ['init', '-b', 'main'],
    ['add', 'fixture.txt'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: repository, stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  return repository
}
