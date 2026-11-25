import { expect, test } from 'bun:test'
import { RELEASE_STARTUP_CEILING_MS, releaseStartupDecision } from './release-startup.ts'

test('release startup allows medians at and under the ceiling', () => {
  expect(releaseStartupDecision([190, 195, RELEASE_STARTUP_CEILING_MS, 200, 200])).toMatchObject({
    ok: true,
    medianMs: RELEASE_STARTUP_CEILING_MS,
  })
  expect(releaseStartupDecision([1, 2, 3, 4, RELEASE_STARTUP_CEILING_MS])).toMatchObject({
    ok: true,
    medianMs: 3,
  })
})

test('release startup refuses a median over the ceiling with its remedy', () => {
  const medianMs = RELEASE_STARTUP_CEILING_MS + 1
  const decision = releaseStartupDecision([
    medianMs - 2,
    medianMs - 1,
    medianMs,
    medianMs + 1,
    medianMs + 2,
  ])

  expect(decision.ok).toBe(false)
  expect(decision.medianMs).toBe(medianMs)
  expect(decision.message).toContain(`${medianMs.toFixed(1)} ms median`)
  expect(decision.message).toContain(`ceiling ${RELEASE_STARTUP_CEILING_MS} ms`)
  expect(decision.message).toContain('binaryCompileArgv')
  expect(decision.message).toContain('--bytecode')
})
