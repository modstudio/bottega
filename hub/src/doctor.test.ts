import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { hubDoctorLines } from './doctor.ts'

beforeAll(resetFixtureStore)

describe('hub doctor', () => {
  const previousHostedUrl = process.env.HUB_HOSTED_URL
  beforeAll(() => {
    delete process.env.HUB_HOSTED_URL
  })
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
    else process.env.HUB_HOSTED_URL = previousHostedUrl
  })

  test('reports the write mode of each registered project', () => {
    const lines = hubDoctorLines()
    expect(lines.some((line) => line.startsWith('install        never-bound'))).toBe(true)
    expect(lines.some((line) => line.startsWith('write mode     local-authoritative'))).toBe(true)
    expect(lines.some((line) => /\balpha\b/.test(line) && line.includes('refused'))).toBe(true)
    expect(
      lines.some((line) => /\bworkshop\b/.test(line) && line.includes('local-authoritative')),
    ).toBe(true)
  })
})
