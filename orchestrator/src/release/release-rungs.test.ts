import { expect, test } from 'bun:test'
import { parseReleaseRungs, releaseRungsFromRegister } from './release-rungs.ts'

test('release rung parsing retains only the tracked snapshot fields', () => {
  expect(
    parseReleaseRungs(
      JSON.stringify({
        rungs: [
          {
            name: 'hosted-api',
            branch: 'main',
            live: 'read hosted api',
            requiredWhenChanged: ['orchestrator/deploy/api/**'],
            entryPoints: ['orchestrator/src/record/record-api-server.ts'],
            onDemand: true,
          },
        ],
      }),
    ),
  ).toEqual({
    rungs: [
      {
        name: 'hosted-api',
        branch: 'main',
        live: 'read hosted api',
        requiredWhenChanged: ['orchestrator/deploy/api/**'],
        entryPoints: ['orchestrator/src/record/record-api-server.ts'],
        onDemand: true,
      },
    ],
  })
})

test('release rung generation refuses a register rung without a live probe', () => {
  expect(() =>
    releaseRungsFromRegister([
      {
        name: 'hosted-api',
        branch: 'main',
      },
    ]),
  ).toThrow('does not declare a commit live probe')
})
