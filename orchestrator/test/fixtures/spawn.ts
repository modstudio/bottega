type FixtureSpawnResult = ReturnType<typeof Bun.spawnSync> & {
  stdout: NonNullable<ReturnType<typeof Bun.spawnSync>['stdout']>
  stderr: NonNullable<ReturnType<typeof Bun.spawnSync>['stderr']>
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
