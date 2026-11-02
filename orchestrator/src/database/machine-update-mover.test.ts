import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV, isInstallationRoot } from '../../../shared/install-root.ts'
import {
  mainCheckoutUpdateInvocation,
  movesRunningBottegaInstallation,
  throwMainCheckoutUpdateFailure,
} from './machine-update-mover.ts'

test('the main-checkout mover names main binary and drops installation and database overrides', () => {
  const projectPath = '/registered/main'
  const invocation = mainCheckoutUpdateInvocation(projectPath, {
    PATH: '/bin',
    [INSTALL_HOME_ENV]: '/linked/tree',
    BOTTEGA_ORCHESTRATOR_DB: '/tmp/override.db',
    BOTTEGA_HUB_DB: '/tmp/hub-override.db',
    BOTTEGA_RUNS: '/tmp/runs',
    KEEP_ME: 'yes',
  })

  expect(invocation).toEqual({
    argv: [join(projectPath, 'bin', PLATFORM_SLUG), 'machine', 'update'],
    cwd: projectPath,
    env: { PATH: '/bin', BOTTEGA_RUNS: '/tmp/runs', KEEP_ME: 'yes' },
  })
})

test('the main-checkout mover has one failure presentation', () => {
  expect(() =>
    throwMainCheckoutUpdateFailure({ exitCode: 7, output: 'migration drain expired' }),
  ).toThrow('migration drain expired')
  expect(() => throwMainCheckoutUpdateFailure({ exitCode: 9, output: '' })).toThrow(
    `${PLATFORM_SLUG} machine update exited 9`,
  )
  expect(() => throwMainCheckoutUpdateFailure({ exitCode: 0, output: '' })).not.toThrow()
})

test('only a non-embedded platform checkout moves the running installation', () => {
  const checkoutRoot = join(import.meta.dir, '../../..')
  expect(movesRunningBottegaInstallation(false, isInstallationRoot(checkoutRoot))).toBeTrue()
  expect(
    movesRunningBottegaInstallation(false, isInstallationRoot('/not/a/platform/checkout')),
  ).toBeFalse()
  expect(movesRunningBottegaInstallation(true, isInstallationRoot(checkoutRoot))).toBeFalse()
})
