import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV, isInstallationRoot } from '../../../shared/install-root.ts'
import {
  mainCheckoutUpdateInvocation,
  movesRunningBottegaInstallation,
} from './machine-update-mover.ts'

test('the main-checkout mover names main binary and drops installation and database overrides', () => {
  const projectPath = '/registered/main'
  const invocation = mainCheckoutUpdateInvocation(projectPath, {
    PATH: '/bin',
    [INSTALL_HOME_ENV]: '/linked/tree',
    BOTTEGA_ORCHESTRATOR_DB: '/tmp/override.db',
    KEEP_ME: 'yes',
  })

  expect(invocation).toEqual({
    argv: [join(projectPath, 'bin', PLATFORM_SLUG), 'machine', 'update'],
    cwd: projectPath,
    env: { PATH: '/bin', KEEP_ME: 'yes' },
  })
})

test('only a non-embedded platform checkout moves the running installation', () => {
  const checkoutRoot = join(import.meta.dir, '../../..')
  expect(movesRunningBottegaInstallation(false, isInstallationRoot(checkoutRoot))).toBeTrue()
  expect(
    movesRunningBottegaInstallation(false, isInstallationRoot('/not/a/platform/checkout')),
  ).toBeFalse()
  expect(movesRunningBottegaInstallation(true, isInstallationRoot(checkoutRoot))).toBeFalse()
})
