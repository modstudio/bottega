import { describe, expect, test } from 'bun:test'
import {
  HOST_RESERVATION_FLOOR_CORES,
  HOST_RESERVATION_MIN_SAMPLES,
  reservedCores,
} from './host-reservation.ts'

describe('host reservation', () => {
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
    expect(reservedCores(samples)).toBe(0.59375)
  })
})
