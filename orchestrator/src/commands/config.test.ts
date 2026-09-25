import { expect, test } from 'bun:test'
import { configGetPresentation, configListPresentation } from './config.ts'

const row = {
  key: 'autonomy.stage.review',
  environment: 'default',
  scope: 'user' as const,
  value: 'review',
  rowVersion: 3,
  updatedAt: '2026-09-25T12:00:00.000Z',
}

test('config get --json presents the structured row', () => {
  expect(JSON.parse(configGetPresentation(row, true))).toEqual(row)
})

test('config list --json presents the structured rows', () => {
  expect(JSON.parse(configListPresentation([row], true)[0]!)).toEqual([row])
})

test('config set --json uses the written structured row presentation', () => {
  expect(JSON.parse(configGetPresentation({ ...row, rowVersion: 4 }, true))).toEqual({
    ...row,
    rowVersion: 4,
  })
})
