import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  parseReleaseRungs,
  releaseRungsDriftDecision,
  releaseRungsFromRegister,
} from './release-rungs.ts'

const tracked = releaseRungsFromRegister([
  {
    name: 'hosted-api',
    branch: 'main',
    live: 'read hosted api',
    requiredWhenChanged: ['orchestrator/deploy/api/**'],
    entryPoints: ['orchestrator/src/record/record-api-server.ts'],
    onDemand: true,
  },
])

describe('release rung snapshot drift', () => {
  test('accepts equal register and tracked rungs', () => {
    expect(releaseRungsDriftDecision(tracked, { ok: true, rungs: tracked }).status).toBe('match')
  })

  test('refuses a differing field and names the generator', () => {
    const edited = parseReleaseRungs(
      JSON.stringify({
        rungs: [{ ...tracked.rungs[0], branch: 'release' }],
      }),
    )
    const decision = releaseRungsDriftDecision(edited, { ok: true, rungs: tracked })
    expect(decision.status).toBe('different')
    expect(decision.message).toContain(`${PLATFORM_SLUG} release rungs --write`)
  })

  test('reports that an unreadable register was not compared', () => {
    expect(releaseRungsDriftDecision(tracked, { ok: false, error: 'store missing' })).toEqual({
      status: 'unverified',
      message:
        'release rungs comparison was not run because the project register could not be read: store missing',
    })
  })
})
