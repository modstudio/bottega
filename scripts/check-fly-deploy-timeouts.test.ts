import { expect, test } from 'bun:test'
import {
  decideFlyDeployTimeouts,
  FLY_DEPLOY_TIMEOUT_FLOOR_MS,
} from './check-fly-deploy-timeouts.ts'

const path = 'deploy/fly.toml'
const floorMs = FLY_DEPLOY_TIMEOUT_FLOOR_MS
const decide = (text: string): string[] => decideFlyDeployTimeouts({ path, text, floorMs })

test('passes with both timeouts at the floor', () => {
  expect(
    decide(
      '[deploy]\nrelease_command = "run migration"\nwait_timeout = "15m"\nrelease_command_timeout = "15m"',
    ),
  ).toEqual([])
})

test('refuses a missing wait timeout', () => {
  expect(
    decide('[deploy]\nrelease_command = "run migration"\nrelease_command_timeout = "15m"'),
  ).toEqual([
    `${path}: [deploy].wait_timeout value <missing>; set wait_timeout = "15m" under [deploy]`,
  ])
})

test('requires a release command timeout only when a release command exists', () => {
  expect(decide('[deploy]\nrelease_command = "run migration"\nwait_timeout = "15m"')).toEqual([
    `${path}: [deploy].release_command_timeout value <missing>; set release_command_timeout = "15m" under [deploy]`,
  ])
  expect(decide('[deploy]\nwait_timeout = "15m"')).toEqual([])
})

test('refuses a timeout below the floor', () => {
  expect(decide('[deploy]\nwait_timeout = "5m"')).toEqual([
    `${path}: [deploy].wait_timeout value "5m" is below the 15m floor; raise wait_timeout to at least "15m"; lowering the floor is an operator ruling in scripts/check-fly-deploy-timeouts.ts`,
  ])
})

test('accepts equivalent and longer Fly durations', () => {
  expect(decide('[deploy]\nwait_timeout = "900s"')).toEqual([])
  expect(decide('[deploy]\nwait_timeout = "1h"')).toEqual([])
})

test('refuses values that are not Fly durations', () => {
  for (const value of ['none', '15 minutes']) {
    expect(decide(`[deploy]\nwait_timeout = "${value}"`)).toEqual([
      `${path}: [deploy].wait_timeout value "${value}" does not parse as a Fly duration; set wait_timeout = "15m" under [deploy] using ms, s, m or h units`,
    ])
  }
})
