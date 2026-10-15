#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../shared/brand.ts'

const args = process.argv.slice(2)
if (args.join('\0') !== ['project', 'list', '--json'].join('\0')) {
  const orch = fileURLToPath(new URL(`../../bin/${PLATFORM_SLUG}`, import.meta.url))
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
      record_id: null,
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
      record_id: null,
      name: 'beta',
      path: '/fixtures/repos/beta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['BET'] },
    },
    {
      id: 3,
      record_id: null,
      name: 'gamma',
      path: '/fixtures/repos/gamma',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['GAM'], space: 'declared-gamma-space' },
    },
    {
      id: 4,
      record_id: null,
      name: 'delta',
      path: '/fixtures/repos/delta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['DEL', 'SHUL'] },
    },
    {
      id: 5,
      record_id: '01990000-0000-7000-8000-000000000075',
      name: 'workshop',
      path: '/fixtures/repos/workshop',
      stack: null,
      canon: true,
      repository: true,
      settings: {
        keyPrefixes: ['LOC'],
        color: '#654321',
        colorDark: '#fedcba',
        tracker: { protocol: 'hub' },
      },
    },
    {
      id: 6,
      record_id: null,
      name: 'nested',
      path: '/fixtures/repos/alpha/packages/nested',
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
    {
      id: 7,
      record_id: null,
      name: 'epsilon',
      path: '/fixtures/repos/epsilon',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['SHR'] },
    },
    {
      id: 8,
      record_id: null,
      name: 'zeta',
      path: '/fixtures/repos/zeta',
      stack: null,
      canon: true,
      repository: true,
      settings: { keyPrefixes: ['SHR'] },
    },
    {
      id: 9,
      record_id: null,
      name: 'stopal',
      path: '/fixtures/repos/stopal',
      stack: null,
      canon: true,
      repository: true,
      settings: {},
    },
  ]),
)
