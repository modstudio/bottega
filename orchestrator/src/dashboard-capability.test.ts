import { expect, test } from 'bun:test'
import { dashboardServeCommand } from './dashboard-capability.ts'

test('dashboard capability recognizes installed and checkout serve commands only', () => {
  expect(dashboardServeCommand('hub serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('/opt/bottega/bin/hub serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun --no-env-file hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun /opt/bottega/hub/src/cli.ts serve --port 7778')).toBe(true)
  expect(dashboardServeCommand('bun hub/src/cli.ts collect --watch')).toBe(false)
  expect(dashboardServeCommand('not-hub serve --port 7778')).toBe(false)
})
