import { scrubbedGitEnv } from '../../../shared/git.ts'

type FixtureSpawnResult = ReturnType<typeof Bun.spawnSync> & {
  stdout: NonNullable<ReturnType<typeof Bun.spawnSync>['stdout']>
  stderr: NonNullable<ReturnType<typeof Bun.spawnSync>['stderr']>
}

export function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv()
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_')) delete env[name]
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  return env
}

export function spawnFixtureSync(
  command: Parameters<typeof Bun.spawnSync>[0],
  options: Parameters<typeof Bun.spawnSync>[1] = {},
): FixtureSpawnResult {
  return Bun.spawnSync(command, {
    ...options,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  }) as FixtureSpawnResult
}
