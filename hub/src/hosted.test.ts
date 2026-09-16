import { describe, expect, test } from 'bun:test'
import { hostedServerConfig } from './hosted.ts'
import { hostedRouter } from './trpc/hosted-router.ts'

describe('hosted server config', () => {
  test('refuses to start without HUB_RECORD_API_URL', () => {
    expect(() => hostedServerConfig({ PORT: '3000' })).toThrow('HUB_RECORD_API_URL is required')
  })

  test('defaults PORT to 3000', () => {
    expect(hostedServerConfig({ HUB_RECORD_API_URL: 'https://api.example.test' }).port).toBe(3000)
  })
})

describe('hostedRouter', () => {
  test('exposes only the record namespace', () => {
    const procedures = Object.keys(hostedRouter._def.procedures).sort()
    expect(procedures).toEqual([
      'record.projects',
      'record.review',
      'record.reviews',
      'record.run',
      'record.runs',
      'record.whoami',
    ])
  })
})
