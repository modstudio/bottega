import { describe, expect, test } from 'bun:test'
import {
  formatProjectWriteModes,
  hostedUnavailableRemedy,
  hostedWriteMode,
  NEVER_BOUND,
  projectBelongsToHostedSpace,
  projectHasRemoteTracker,
  projectMappedToHostedSpace,
  projectWriteDecisionFor,
  reportedWriteMode,
} from './hosted-write-mode.ts'

const bound = { bound: true, activeSpaceId: 'space-a' }

const hublocal = {
  name: 'hublocal',
  settings: { tracker: { protocol: 'hub' as const }, keyPrefixes: ['DEV'] },
}
const workshop = {
  name: 'workshop',
  settings: { tracker: { protocol: 'hub' as const }, keyPrefixes: ['LOC'] },
}
const alpha = {
  name: 'alpha',
  settings: { tracker: { protocol: 'workspace-mcp' as const }, keyPrefixes: ['ALP'] },
}
const gamma = {
  name: 'gamma',
  settings: { tracker: { protocol: 'hub' as const }, space: 'team-space', keyPrefixes: ['GAM'] },
}

describe('hosted write mode', () => {
  test('hosted-configured when HUB_HOSTED_URL is set, otherwise local-authoritative', () => {
    expect(hostedWriteMode('https://hub.example')).toBe('hosted-configured')
    expect(hostedWriteMode(' https://hub.example ')).toBe('hosted-configured')
    expect(hostedWriteMode(undefined)).toBe('local-authoritative')
    expect(hostedWriteMode(null)).toBe('local-authoritative')
    expect(hostedWriteMode('')).toBe('local-authoritative')
    expect(hostedWriteMode('   ')).toBe('local-authoritative')
  })

  test('a hosted-bound install with no URL is hosted-unavailable, not local-authoritative', () => {
    expect(reportedWriteMode(undefined, bound)).toBe('hosted-unavailable')
    expect(reportedWriteMode('https://hub.example', bound)).toBe('hosted-configured')
    expect(reportedWriteMode(undefined, NEVER_BOUND)).toBe('local-authoritative')
  })

  test('a hub-protocol or absent tracker is not remote; any other tracker is', () => {
    expect(projectHasRemoteTracker(undefined)).toBe(false)
    expect(projectHasRemoteTracker({ protocol: 'hub' })).toBe(false)
    expect(projectHasRemoteTracker({ protocol: 'workspace-mcp' })).toBe(true)
    expect(projectHasRemoteTracker({ protocol: 'cursor-mcp' })).toBe(true)
    expect(projectHasRemoteTracker({ protocol: 'array-mcp' })).toBe(true)
    expect(projectHasRemoteTracker({})).toBe(true)
  })

  test('a mapped hosted space is a non-empty space slug', () => {
    expect(projectMappedToHostedSpace(undefined)).toBe(false)
    expect(projectMappedToHostedSpace('')).toBe(false)
    expect(projectMappedToHostedSpace('  ')).toBe(false)
    expect(projectMappedToHostedSpace('team-space')).toBe(true)
  })

  test('a missing declared space is hosted only on a hosted-bound install', () => {
    expect(projectBelongsToHostedSpace(undefined, NEVER_BOUND)).toBe(false)
    expect(projectBelongsToHostedSpace(undefined, bound)).toBe(true)
    expect(projectBelongsToHostedSpace('team-space', NEVER_BOUND)).toBe(true)
  })

  test('a never-bound hub-protocol project writes locally only when hosting is unset', () => {
    expect(projectWriteDecisionFor(workshop, NEVER_BOUND, undefined)).toEqual({
      mode: 'local-authoritative',
    })
    expect(projectWriteDecisionFor(workshop, NEVER_BOUND, 'https://hub.example')).toEqual({
      mode: 'hosted-configured',
    })
  })

  test('a hosted-bound install with HUB_HOSTED_URL unset refuses hublocal-shaped writes', () => {
    const decision = projectWriteDecisionFor(hublocal, bound, undefined)
    expect(decision.mode).toBe('refused')
    if (decision.mode !== 'refused') throw new Error('expected refusal')
    expect(decision.cause).toBe('hosted-space')
    expect(decision.reason).toContain("project 'hublocal' belongs to a hosted space")
    expect(decision.reason).toContain('Set HUB_HOSTED_URL')
    expect(decision.reason).not.toContain('run with no hosted record')
    expect(projectWriteDecisionFor(hublocal, bound, 'https://hub.example')).toEqual({
      mode: 'hosted-configured',
    })
  })

  test('a remote-tracker project refuses local writes when hosting is absent', () => {
    const decision = projectWriteDecisionFor(alpha, NEVER_BOUND, undefined)
    expect(decision.mode).toBe('refused')
    if (decision.mode !== 'refused') throw new Error('expected refusal')
    expect(decision.cause).toBe('remote-tracker')
    expect(decision.reason).toContain("project 'alpha' declares a remote tracker")
    expect(decision.reason).toContain('Set HUB_HOSTED_URL')
    expect(projectWriteDecisionFor(alpha, NEVER_BOUND, 'https://hub.example')).toEqual({
      mode: 'hosted-configured',
    })
  })

  test('a hosted-space project refuses local writes when hosting is absent', () => {
    const decision = projectWriteDecisionFor(gamma, NEVER_BOUND, undefined)
    expect(decision.mode).toBe('refused')
    if (decision.mode !== 'refused') throw new Error('expected refusal')
    expect(decision.cause).toBe('hosted-space')
    expect(decision.reason).toContain("project 'gamma' belongs to a hosted space")
  })

  test('unreachable remedies name retry, and the missing-URL remedy only when the URL is missing', () => {
    expect(hostedUnavailableRemedy('https://hub.example')).toBe(
      'Retry when the hosted record is reachable.',
    )
    expect(hostedUnavailableRemedy(undefined)).toContain('Set HUB_HOSTED_URL')
    expect(hostedUnavailableRemedy(undefined)).toContain('orch record doctor')
    expect(hostedUnavailableRemedy(undefined)).not.toContain('run with no hosted record')
    expect(hostedUnavailableRemedy('https://hub.example')).not.toContain('Set HUB_HOSTED_URL')
  })

  test('doctor lists the install binding and the mode of each project', () => {
    expect(formatProjectWriteModes([alpha, workshop, gamma], NEVER_BOUND, undefined)).toEqual([
      'install        never-bound',
      'write mode     local-authoritative',
      '  alpha          refused (remote-tracker)',
      '  workshop       local-authoritative',
      '  gamma          refused (hosted-space)',
    ])
    expect(formatProjectWriteModes([hublocal, workshop], bound, undefined)).toEqual([
      'install        hosted-bound',
      'write mode     hosted-unavailable',
      '  hublocal       refused (hosted-space)',
      '  workshop       refused (hosted-space)',
    ])
    expect(formatProjectWriteModes([workshop], NEVER_BOUND, 'https://hub.example')).toEqual([
      'install        never-bound',
      'write mode     hosted-configured',
      '  workshop       hosted-configured',
    ])
  })
})
