import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { createWorkerWorktree } from './worktree.ts'
import { seedPreflight } from './worktree-seed.ts'

afterEach(() => {
  mock.restore()
})

test('worktree creation from a non-main cwd starts compose in the registered main checkout', () => {
  const originalSpawnSync = Bun.spawnSync
  const composeCalls: { args: string[]; cwd: string | undefined }[] = []
  const registeredMain = '/registered/projects/example'
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: { cwd?: string }) => {
    if (args[0] !== 'docker') return originalSpawnSync(args, options as never)
    composeCalls.push({ args, cwd: options?.cwd })
    if (args.includes('--status')) return result('')
    if (args.includes('ps')) return result('exited-setup')
    return result('')
  }) as typeof Bun.spawnSync)

  const refusal = seedPreflight({
    requested: undefined,
    registerChoices: ['required'],
    recipeSeeds: undefined,
  }).refusal!
  expect(() =>
    createWorkerWorktree({
      tool: { seeds: ['required'] },
      cwd: import.meta.dir,
      mainProjectPath: registeredMain,
      runId: 999_991,
      writes: true,
      readOnlyBase: 'HEAD',
      record: () => undefined,
      detached: false,
      mainStackConsumers: ['worktree-create'],
    }),
  ).toThrow(refusal)

  expect(composeCalls).toEqual([
    {
      args: ['docker', 'compose', 'ps', '--status', 'running', '--services'],
      cwd: registeredMain,
    },
    {
      args: ['docker', 'compose', 'up', '-d', '--wait'],
      cwd: registeredMain,
    },
  ])
})

function result(stdout: string): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
