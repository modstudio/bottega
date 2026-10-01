import { expect, test } from 'bun:test'
import { checkTaskKeyAdmission, type TaskKeyLookupResult } from './task-key-admission.ts'

const check = (result: TaskKeyLookupResult, protocol = 'hub') =>
  checkTaskKeyAdmission({ project: 'fixture', key: 'DEV-1028', protocol }, async (project, key) => {
    expect({ project, key }).toEqual({ project: 'fixture', key: 'DEV-1028' })
    return result
  })

test('task key admission proceeds when the tracker finds the task', async () => {
  expect(await check({ state: 'found' })).toEqual({ action: 'proceed', warning: null })
})

test('task key admission refuses a task the tracker did not find', async () => {
  expect(await check({ state: 'not-found' })).toEqual({
    action: 'refuse',
    message:
      'task DEV-1028 does not exist in project fixture; create it with hub task new --project fixture, or correct --key',
  })
})

test('task key admission warns and proceeds when the tracker is unreachable', async () => {
  expect(await check({ state: 'unreachable', condition: 'hub exited 1' })).toEqual({
    action: 'proceed',
    warning:
      '! task DEV-1028 could not be verified in project fixture: hub exited 1; dispatch will proceed because tracker availability does not gate dispatch',
  })
})
