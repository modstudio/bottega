import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { dashboardServeCommand } from './dashboard-capability.ts'

test('dashboard capability recognizes installed and checkout serve commands only', () => {
  expect(dashboardServeCommand(`${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(true)
  expect(dashboardServeCommand(`/opt/app/bin/${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(
    true,
  )
  expect(
    dashboardServeCommand('bun --no-env-file cli/bottega.ts dashboard start --port 7778'),
  ).toBe(true)
  expect(
    dashboardServeCommand('bun --no-env-file /opt/app/cli/bottega.ts dashboard start --port 7778'),
  ).toBe(true)
  expect(dashboardServeCommand('bun --no-env-file hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun /opt/app/hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun hub/src/cli.ts collect --watch')).toBe(false)
  expect(dashboardServeCommand(`not-${PLATFORM_SLUG} dashboard start --port 7778`)).toBe(false)
})
