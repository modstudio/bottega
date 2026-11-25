import { expect, test } from 'bun:test'
import { hostedReleaseParityViolations } from './check-hosted-release-parity.ts'

test('a local release gate without its hosted call is refused', () => {
  expect(
    hostedReleaseParityViolations([
      { path: 'orchestrator/src/example.ts', text: 'if (releaseLocalClaims) releaseClaims()' },
    ]),
  ).toEqual([
    'orchestrator/src/example.ts:1: releaseLocalClaims gate has no releaseHostedClaims( call; add a releaseHostedClaims( call beside the releaseLocalClaims gate, or rename the gate if it releases nothing hosted',
  ])
})

test('a local release gate with its hosted call passes', () => {
  expect(
    hostedReleaseParityViolations([
      {
        path: 'orchestrator/src/example.ts',
        text: 'if (releaseLocalClaims) releaseClaims()\nreleaseHostedClaims()',
      },
    ]),
  ).toEqual([])
})

test('test files are ignored', () => {
  expect(
    hostedReleaseParityViolations([
      {
        path: 'orchestrator/src/example.test.ts',
        text: 'if (releaseLocalClaims) releaseClaims()',
      },
    ]),
  ).toEqual([])
})
