import { expect, test } from 'bun:test'
import { decideBunVersions } from './check-bun-versions.ts'

test('passes when every deploy image pin agrees with the target', () => {
  expect(
    decideBunVersions('1.4.4', [
      { path: 'hub/deploy/Dockerfile', line: 1, version: '1.4.4' },
      { path: 'orchestrator/deploy/api/Dockerfile', line: 3, version: '1.4.4' },
    ]),
  ).toBeUndefined()
})

test('refuses a Dockerfile pin that differs from the target', () => {
  expect(
    decideBunVersions('1.4.4', [
      { path: 'hub/deploy/Dockerfile', line: 1, version: '1.3.14' },
      { path: 'orchestrator/deploy/api/Dockerfile', line: 3, version: '1.4.4' },
    ]),
  ).toBe(
    'deploy image Bun version check failed\nhub/deploy/Dockerfile:1: Bun 1.3.14\nset every pin to 1.4.4',
  )
})

test('passes when there are no deploy image pins', () => {
  expect(decideBunVersions('1.4.4', [])).toBeUndefined()
})
