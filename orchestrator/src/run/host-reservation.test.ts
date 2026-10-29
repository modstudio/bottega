import { describe, expect, test } from 'bun:test'
import {
  activeCores,
  HOST_RESERVATION_FLOOR_CORES,
  HOST_RESERVATION_MIN_SAMPLES,
  HOST_RESERVATION_PERCENTILE,
  reservedCores,
} from './host-reservation.ts'

describe('host reservation', () => {
  test('measures cores over active time after subtracting the host wait', () => {
    const startedAt = Date.parse('2026-10-29T18:20:00.000Z')
    expect(
      activeCores({
        startedAt: new Date(startedAt).toISOString(),
        latencyMs: 120_000,
        agentStartTime: new Date(startedAt + 60_000).toString(),
        resourceCpuMs: 30_000,
      }),
    ).toBe(0.5)
  })

  test('drops a sample with an unparseable agent start time', () => {
    expect(
      activeCores({
        startedAt: '2026-10-29T18:20:00.000Z',
        latencyMs: 120_000,
        agentStartTime: 'not-a-time',
        resourceCpuMs: 30_000,
      }),
    ).toBeNull()
  })

  test('sparse evidence reserves a full core', () => {
    expect(reservedCores(Array(HOST_RESERVATION_MIN_SAMPLES - 1).fill(0.05))).toBe(1)
  })

  test('a tiny percentile is raised to the floor', () => {
    expect(reservedCores(Array(HOST_RESERVATION_MIN_SAMPLES).fill(0.05))).toBe(
      HOST_RESERVATION_FLOOR_CORES,
    )
  })

  test('a high percentile is capped at one core', () => {
    expect(reservedCores(Array(HOST_RESERVATION_MIN_SAMPLES).fill(2))).toBe(1)
  })

  test('selects the nearest-rank percentile', () => {
    const samples = Array.from(
      { length: HOST_RESERVATION_MIN_SAMPLES },
      (_, index) => (index + 1) * 0.03125,
    )
    const nearestRank = Math.ceil(HOST_RESERVATION_PERCENTILE * samples.length)
    expect(reservedCores(samples)).toBe(samples[nearestRank - 1]!)
  })
})
