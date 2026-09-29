import { describe, expect, test } from 'bun:test'
import { hostedServerConfig } from './hosted.ts'
import { hostedRouter } from './trpc/hosted-router.ts'

describe('hosted server config', () => {
  test('refuses to start without HUB_RECORD_API_URL', () => {
    expect(() => hostedServerConfig({ PORT: '3000' })).toThrow('HUB_RECORD_API_URL is required')
  })

  test('refuses to start without HUB_RECORD_DATABASE_URL', () => {
    expect(() => hostedServerConfig({ HUB_RECORD_API_URL: 'https://api.example.test' })).toThrow(
      'HUB_RECORD_DATABASE_URL is required',
    )
  })

  test('defaults PORT to 3000', () => {
    expect(
      hostedServerConfig({
        HUB_RECORD_API_URL: 'https://api.example.test',
        HUB_RECORD_DATABASE_URL: 'postgres://example.test/db',
      }).port,
    ).toBe(3000)
  })
})

describe('hostedRouter', () => {
  test('exposes the record and hosted context namespaces', () => {
    const procedures = Object.keys(hostedRouter._def.procedures).sort()
    expect(procedures).toEqual([
      'context.autonomy.get',
      'context.autonomy.set',
      'context.autonomy.setPreset',
      'context.autonomy.setRelease',
      'context.projects',
      'context.settings.get',
      'context.settings.permission',
      'context.userCanon.get',
      'context.userCanon.list',
      'context.userCanon.remove',
      'context.userCanon.set',
      'record.agents',
      'record.board',
      'record.createReportSubscription',
      'record.doc',
      'record.docRevisions',
      'record.docs',
      'record.done',
      'record.flight',
      'record.health',
      'record.jobs',
      'record.measurePeople',
      'record.measures',
      'record.notes',
      'record.projects',
      'record.ratio',
      'record.removeReportSubscription',
      'record.review',
      'record.reviews',
      'record.routing',
      'record.run',
      'record.runsView',
      'record.score',
      'record.sendReportSubscriptionTest',
      'record.setActiveSpace',
      'record.settings',
      'record.snapshots',
      'record.spend',
      'record.task',
      'record.updateReportSubscription',
      'record.void',
      'record.whoami',
    ])
  })
})
