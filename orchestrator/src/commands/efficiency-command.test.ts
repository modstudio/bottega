import { expect, test } from 'bun:test'
import {
  efficiencyWindows,
  provisioningAliasOptions,
  selectedEfficiencySections,
} from './efficiency-command.ts'

test('efficiency windows default to adjacent seven-day periods', () => {
  expect(efficiencyWindows(undefined, Date.parse('2026-10-15T00:00:00Z'))).toEqual({
    currentWindow: {
      start: '2026-10-08T00:00:00.000Z',
      end: '2026-10-15T00:00:00.000Z',
    },
    previousWindow: {
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-08T00:00:00.000Z',
    },
  })
})

test('section selection follows report order and provisioning aliases one section', () => {
  expect(selectedEfficiencySections(['cycle-cost', 'provisioning'])).toEqual([
    'provisioning',
    'cycle-cost',
  ])
  expect(
    provisioningAliasOptions({ json: true, resources: false, project: 'app', since: '2d' }),
  ).toEqual({
    json: true,
    project: 'app',
    since: '2d',
    sections: ['provisioning'],
  })
  expect(provisioningAliasOptions({ json: false, resources: true })).toMatchObject({
    sections: ['resources'],
  })
})
