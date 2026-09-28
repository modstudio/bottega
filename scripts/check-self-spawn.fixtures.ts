export const rejectedSelfSpawnFixtures = {
  'repeated local name': `
    const command = ['bun', 'orchestrator/src/run/exec.ts']
    function unrelated() {
      const command = ['git', 'status']
      return command
    }
    Bun.spawn(command)
  `,
  'parameter holding bun': `
    function launch(executable = 'bun') {
      Bun.spawn([executable, 'hub/src/cli.ts'])
    }
  `,
  'spawn import alias': `
    import { spawn as launch } from 'node:child_process'
    launch('bun', ['retrieval/src/search-cli.ts'])
  `,
  'process execPath with source path': `
    Bun.spawn([process.execPath, 'orchestrator/src/cli/orch.ts'])
  `,
  'resolver mentioned after direct entry': `
    Bun.spawn(['bun', 'hub/src/cli.ts', ...bottegaEntryArgv('hub')])
  `,
}

export const acceptedSelfSpawnFixture = `
  const command = [...bottegaEntryArgv('hub'), 'hub/src/cli.ts']
  Bun.spawn(command)
`
