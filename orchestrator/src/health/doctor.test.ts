import { describe, expect, test } from 'bun:test'
import { canonEvalDoctorDecision } from './doctor.ts'

describe('doctor canon eval presentation', () => {
  test('marks only an established result against the current platform canon as current', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'current-sha',
        currentSha: 'current-sha',
        currentCanonError: null,
      }),
    ).toEqual({ result: 'pass (current canon)', unavailableReason: null })
  })

  test('keeps reporting rows and names why the platform canon could not be computed', () => {
    expect(
      canonEvalDoctorDecision({
        pass: true,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'pass', unavailableReason: 'project has no canon' })
    expect(
      canonEvalDoctorDecision({
        pass: false,
        recordedSha: 'recorded-sha',
        currentSha: null,
        currentCanonError: 'project has no canon',
      }),
    ).toEqual({ result: 'FAIL', unavailableReason: 'project has no canon' })
  })
})
