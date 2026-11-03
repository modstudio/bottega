import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MAINTENANCE_SCHEDULE_LABELS, renderMaintenanceSchedule } from './setup-schedules.ts'

test('distribution schedule rendering replaces every placeholder for both labels', () => {
  for (const label of MAINTENANCE_SCHEDULE_LABELS) {
    const template = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'ops', 'launchd', `${label}.plist.template`),
      'utf8',
    )
    const rendered = renderMaintenanceSchedule(template, {
      bottegaBin: `/Applications/${PLATFORM_NAME}/${PLATFORM_SLUG}`,
      home: '/Users/operator',
      stateHomeEnvironment: 'BOTTEGA_STATE_HOME',
      stateHome: `/Users/operator/.local/state/${PLATFORM_SLUG}`,
    })
    expect(rendered).toContain(`/Applications/${PLATFORM_NAME}/${PLATFORM_SLUG}`)
    expect(rendered.match(/__[A-Z0-9_]+__/g)).toBeNull()
  }
})
