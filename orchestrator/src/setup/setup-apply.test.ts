import { expect, test } from 'bun:test'
import { applySetupActions } from './setup-apply.ts'
import type { SetupAction } from './setup-planner.ts'

const action = (name: string): SetupAction => ({
  kind: 'add',
  name,
  path: `/repos/${name}`,
  stack: null,
  settings: {},
  settingsDiff: {},
})

test('stops at the first refusal and marks remaining actions not attempted', async () => {
  const attempted: string[] = []
  const results = await applySetupActions([action('one'), action('two'), action('three')], {
    add: async (candidate) => {
      attempted.push(candidate.name)
      if (candidate.name === 'two') throw new Error('service refused two')
    },
    fillAbsent: async () => {},
  })
  expect(attempted).toEqual(['one', 'two'])
  expect(results.map((result) => result.status)).toEqual(['applied', 'refused', 'not-attempted'])
  expect(results[1]?.message).toBe('service refused two')
})
