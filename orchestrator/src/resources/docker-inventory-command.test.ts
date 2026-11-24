import { expect, test } from 'bun:test'
import { gatherDockerHostEvidence } from './docker-host-evidence.ts'
import {
  decideDockerInventoryAvailability,
  executableAbsentFrom,
} from './docker-inventory-command.ts'

test('Docker executable absence is classified structurally', () => {
  expect(executableAbsentFrom(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBeTrue()
  expect(executableAbsentFrom(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBeFalse()
})

test('Docker inventory availability proceeds only with an available inventory', () => {
  expect(decideDockerInventoryAvailability({ ok: true })).toEqual({ kind: 'proceed' })
})

test('Docker inventory availability treats ENOENT without host evidence as absent', () => {
  expect(
    decideDockerInventoryAvailability({
      ok: false,
      reason: 'missing',
      executableAbsent: true,
      executablePaths: [],
      daemonSocketPaths: [],
    }),
  ).toEqual({ kind: 'docker-absent' })
})

test('Docker inventory availability fails and names an executable found off PATH', () => {
  expect(
    decideDockerInventoryAvailability({
      ok: false,
      reason: 'missing',
      executableAbsent: true,
      executablePaths: ['/opt/homebrew/bin/docker'],
      daemonSocketPaths: [],
    }),
  ).toEqual({
    kind: 'fail',
    reason: 'docker not on PATH but /opt/homebrew/bin/docker exists; add /opt/homebrew/bin to PATH',
  })
})

test('Docker inventory availability fails and names daemon socket evidence', () => {
  expect(
    decideDockerInventoryAvailability({
      ok: false,
      reason: 'missing',
      executableAbsent: true,
      executablePaths: [],
      daemonSocketPaths: ['/var/run/docker.sock'],
    }),
  ).toEqual({
    kind: 'fail',
    reason:
      'docker not on PATH but daemon socket /var/run/docker.sock exists; put docker on PATH or set DOCKER_HOST',
  })
})

test('Docker inventory availability fails for a nonzero Docker exit', () => {
  expect(
    decideDockerInventoryAvailability({
      ok: false,
      reason: 'daemon unavailable',
      executableAbsent: false,
      executablePaths: [],
      daemonSocketPaths: [],
    }),
  ).toEqual({ kind: 'fail', reason: 'daemon unavailable' })
})

test('Docker inventory availability treats a timeout as failure', () => {
  expect(
    decideDockerInventoryAvailability({
      ok: false,
      reason: 'timed out',
      executableAbsent: false,
      executablePaths: [],
      daemonSocketPaths: [],
    }),
  ).toEqual({ kind: 'fail', reason: 'timed out' })
})

test('Docker host evidence resolves every dynamic path and probes existence only', () => {
  const existing = new Set([
    '/home/test/.rd/bin/docker',
    '/runtime/docker.sock',
    '/home/test/.orbstack/run/docker.sock',
    '/home/test/.colima/default/docker.sock',
  ])
  expect(
    gatherDockerHostEvidence({
      env: { DOCKER_HOST: 'unix:///daemon/docker.sock', XDG_RUNTIME_DIR: '/runtime' },
      home: '/home/test',
      exists: (path) => existing.has(path),
      colimaSockets: () => ['/home/test/.colima/default/docker.sock'],
    }),
  ).toEqual({
    executablePaths: ['/home/test/.rd/bin/docker'],
    daemonSocketPaths: [
      '/runtime/docker.sock',
      '/home/test/.orbstack/run/docker.sock',
      '/home/test/.colima/default/docker.sock',
    ],
  })
})
