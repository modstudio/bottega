import { expect, test } from 'bun:test'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { canonicalSocketDenyPaths, readonlyLensReportInputs } from './sandbox.ts'

test.each([
  {
    name: 'resolves a symlinked-parent path to its target',
    paths: ['/var/run/docker.sock'],
    resolved: { '/var/run': '/run' },
    expected: ['/run/docker.sock'],
  },
  {
    name: 'keeps a missing socket when its parent cannot be resolved',
    paths: ['/missing/docker.sock'],
    resolved: {},
    expected: ['/missing/docker.sock'],
  },
  {
    name: 'dedupes paths that resolve to one target',
    paths: ['/var/run/docker.sock', '/run/docker.sock'],
    resolved: {
      '/var/run': '/run',
      '/run': '/run',
    },
    expected: ['/run/docker.sock'],
  },
])('$name', ({ paths, resolved, expected }) => {
  expect(
    canonicalSocketDenyPaths(paths, (path) => resolved[path as keyof typeof resolved] ?? null),
  ).toEqual([...expected])
})

test('confinement report inputs use the injected socket denies', () => {
  const socketDenyPaths = ['/test/run/docker.sock', '/test/custom/docker.sock'] as const
  const environment = {
    HOME: '/Users/operator',
    [STATE_HOME_ENV]: '/operator/state',
    [CONFIG_HOME_ENV]: '/operator/config',
  }

  expect(readonlyLensReportInputs(environment, null, socketDenyPaths).denyRead).toEqual(
    expect.arrayContaining(socketDenyPaths),
  )
})
