#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.join('\0') !== ['project', 'list', '--json'].join('\0')) {
  const orch = fileURLToPath(new URL('../../bin/orch', import.meta.url))
  const result = Bun.spawnSync([orch, ...args], {
    env: process.env,
    stdin: await Bun.stdin.bytes(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await Bun.write(Bun.stdout, result.stdout)
  await Bun.write(Bun.stderr, result.stderr)
  process.exit(result.exitCode)
}

console.log(
  JSON.stringify([
    {
      id: 1,
      name: 'alpha',
      path: '/fixtures/repos/alpha',
      stack: null,
      canon: true,
      repository: true,
      settings: {
        keyPrefixes: ['ALP'],
        color: '#112233',
        colorDark: '#aabbcc',
        tracker: {
          protocol: 'workspace-mcp',
          envPrefix: 'FIXTURE_NO_CREDENTIALS',
          openStatuses: ['started'],
          states: { started: 'active', completed: 'done' },
        },
      },
    },
    {
      id: 2,
      name: 'beta',
      path: '/fixtures/repos/beta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['BET'] },
    },
    {
      id: 3,
      name: 'gamma',
      path: '/fixtures/repos/gamma',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['GAM'] },
    },
    {
      id: 4,
      name: 'delta',
      path: '/fixtures/repos/delta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['DEL', 'SHUL'] },
    },
    {
      id: 5,
      name: 'workshop',
      path: '/fixtures/repos/workshop',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['LOC'], color: '#654321', colorDark: '#fedcba' },
    },
    {
      id: 6,
      name: 'nested',
      path: '/fixtures/repos/alpha/packages/nested',
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
    {
      id: 7,
      name: 'epsilon',
      path: '/fixtures/repos/epsilon',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['SHR'] },
    },
    {
      id: 8,
      name: 'zeta',
      path: '/fixtures/repos/zeta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['SHR'] },
    },
    {
      id: 9,
      name: 'stopal',
      path: '/fixtures/repos/stopal',
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
  ]),
)
