import { expect, test } from 'bun:test'
import { typedQuestionMetrics } from './typed-question-metrics.ts'

const row = (probability: number, label: boolean | null) => ({
  probability,
  label,
  error: null,
  latencyMs: 10,
  inputTokens: 0,
})

test('computes Mann-Whitney AUC with half credit for ties', () => {
  expect(typedQuestionMetrics([row(0.9, true), row(0.5, true), row(0.5, false)], 0.8).auc).toBe(
    0.75,
  )
})

test('returns null AUC when one labeled class is empty', () => {
  expect(typedQuestionMetrics([row(0.9, true), row(0.2, true)], 0.8).auc).toBeNull()
})

test('includes the threshold boundary in precision and recall', () => {
  const metrics = typedQuestionMetrics([row(0.8, true), row(0.8, false), row(0.7, true)], 0.8)
  expect(metrics.precision).toBe(0.5)
  expect(metrics.recall).toBe(0.5)
})

test('excludes pending answers from AUC and base rate', () => {
  const metrics = typedQuestionMetrics(
    [row(0.9, true), row(0.1, false), row(1, null), row(0, null)],
    0.8,
  )
  expect(metrics.labeled).toBe(2)
  expect(metrics.pending).toBe(2)
  expect(metrics.baseRate).toBe(0.5)
  expect(metrics.auc).toBe(1)
})

test('totals input tokens and prices them at the named rate', () => {
  const metrics = typedQuestionMetrics(
    [
      { ...row(0.9, true), inputTokens: 750_000 },
      { ...row(0.1, false), inputTokens: 250_000 },
    ],
    0.8,
  )
  expect(metrics.inputTokens).toBe(1_000_000)
  expect(metrics.costUsd).toBe(0.042)
})

test('computes calibration metrics from labeled answers', () => {
  const metrics = typedQuestionMetrics([row(0.2, false), row(0.8, true)], 0.5)
  expect(metrics.brier).toBeCloseTo(0.04)
  expect(metrics.logLoss).toBeCloseTo(-Math.log(0.8))
  expect(metrics.ece).toBeCloseTo(0.2)
})

test('clamps probabilities for log loss and puts one in the last ECE bin', () => {
  const metrics = typedQuestionMetrics([row(0, true), row(1, false), row(1, true)], 0.5)
  expect(metrics.brier).toBeCloseTo(2 / 3)
  expect(metrics.logLoss).toBeCloseTo((-2 * Math.log(1e-6) - Math.log(1 - 1e-6)) / 3)
  expect(metrics.ece).toBeCloseTo(2 / 3)
})

test('returns null calibration metrics without labeled answers', () => {
  const metrics = typedQuestionMetrics([row(0.5, null)], 0.5)
  expect(metrics).toMatchObject({ brier: null, logLoss: null, ece: null })
})
