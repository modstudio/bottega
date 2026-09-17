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
  test('exposes only the record namespace', () => {
    const procedures = Object.keys(hostedRouter._def.procedures).sort()
    expect(procedures).toEqual([
      'record.agents',
      'record.board',
      'record.doc',
      'record.docRevisions',
      'record.docs',
      'record.done',
      'record.flight',
      'record.health',
      'record.jobs',
      'record.notes',
      'record.projects',
      'record.ratio',
      'record.review',
      'record.reviews',
      'record.routing',
      'record.run',
      'record.runs',
      'record.setActiveSpace',
      'record.settings',
      'record.snapshots',
      'record.spend',
      'record.task',
      'record.whoami',
    ])
  })
})
