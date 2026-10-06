import { scrubbedGitEnv } from '../../../shared/git.ts'

type FixtureSpawnResult = ReturnType<typeof Bun.spawnSync> & {
  stdout: NonNullable<ReturnType<typeof Bun.spawnSync>['stdout']>
  stderr: NonNullable<ReturnType<typeof Bun.spawnSync>['stderr']>
}

function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv()
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_')) delete env[name]
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '0'
  return env
}

export function spawnFixtureGitSync(
  argv: string[],
  options: Omit<Parameters<typeof Bun.spawnSync>[1], 'env'> = {},
): FixtureSpawnResult {
  return Bun.spawnSync(['git', ...argv], {
    ...options,
    env: fixtureGitEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  }) as FixtureSpawnResult
}

export function spawnFixtureSync(
  command: Parameters<typeof Bun.spawnSync>[0],
  options: Parameters<typeof Bun.spawnSync>[1] = {},
): FixtureSpawnResult {
  const env = { ...process.env, ...options.env }
  delete env.FORCE_COLOR
  delete env.NO_COLOR
  return Bun.spawnSync(command, {
    ...options,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as FixtureSpawnResult
}
