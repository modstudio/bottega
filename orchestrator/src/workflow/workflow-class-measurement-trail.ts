// concern: workflows
/** Owns class-measurement vocabulary and reads it from a closed cursor trail. */

import type { ClosedStep } from './workflow-cursor-trail.ts'

const CLASS_MEASUREMENT_STEP = 'measure-class'
const IMPLEMENT_FIX_STEP = 'implement-fix'
export const CLASS_MEASUREMENT_EVIDENCE = {
  className: '--class',
  command: '--command',
  execId: '--exec',
  count: '--count',
} as const

export type TrailClassMeasurement = {
  className: string
  command: string
  count: number
  implementClosedAt?: string
}

export function classMeasurementFromClosedSteps(
  closed: readonly ClosedStep[],
): TrailClassMeasurement | null {
  const measured = closed.find((step) => step.slug === CLASS_MEASUREMENT_STEP)
  if (!measured) return null
  const values = Object.fromEntries(
    (measured.evidence ?? []).map((item) => [item.flag, item.value]),
  )
  const className = values[CLASS_MEASUREMENT_EVIDENCE.className]?.trim()
  const command = values[CLASS_MEASUREMENT_EVIDENCE.command]
  const countValue = values[CLASS_MEASUREMENT_EVIDENCE.count]
  if (!className || !command || !countValue || !/^\d+$/.test(countValue)) return null
  const count = Number(countValue)
  if (!Number.isSafeInteger(count)) return null
  const implementClosedAt = closed.findLast((step) => step.slug === IMPLEMENT_FIX_STEP)?.at
  return { className, command, count, ...(implementClosedAt ? { implementClosedAt } : {}) }
}
