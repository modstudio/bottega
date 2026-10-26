import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { PRODUCT_CLI_ENTRYPOINT } from '../../shared/install-root.ts'
import { dashboardServeCommand } from './dashboard-capability.ts'

test('dashboard capability recognizes installed and checkout serve commands only', () => {
  expect(dashboardServeCommand(`${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(true)
  expect(dashboardServeCommand(`/opt/app/bin/${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(
    true,
  )
  expect(
    dashboardServeCommand(`bun --no-env-file cli/${PLATFORM_SLUG}.ts dashboard start --port 7778`),
  ).toBe(true)
  expect(
    dashboardServeCommand(
      `bun --no-env-file /opt/app/cli/${PLATFORM_SLUG}.ts dashboard start --port 7778`,
    ),
  ).toBe(true)
  expect(
    dashboardServeCommand(
      `bun --no-env-file /opt/app/${PRODUCT_CLI_ENTRYPOINT} dashboard start --port 7778`,
    ),
  ).toBe(true)
  expect(dashboardServeCommand('bun --no-env-file hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun /opt/app/hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun hub/src/cli.ts collect --watch')).toBe(false)
  expect(dashboardServeCommand(`not-${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(false)
})
