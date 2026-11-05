/** Vocabulary accepted by every workflow-autonomy boundary. */
import type { ShipToValue } from './ship-to.ts'

export const AUTONOMY_STAGES = ['plan', 'implement', 'review', 'docs', 'canon', 'ship'] as const
export const AUTONOMY_VALUES = ['ask', 'review', 'auto'] as const
export const AUTONOMY_PRESETS = ['manual', 'guided', 'autonomous'] as const
export const STAGE_AUTONOMY_VALUES = [...AUTONOMY_VALUES, 'per step'] as const

export type AutonomyStage = (typeof AUTONOMY_STAGES)[number]
export type AutonomyValue = (typeof AUTONOMY_VALUES)[number]
export type AutonomyPreset = (typeof AUTONOMY_PRESETS)[number]
export type StageAutonomyValue = (typeof STAGE_AUTONOMY_VALUES)[number]
export type AutonomyLayerRow = {
  scope: string
  preset: AutonomyPreset | null
  rulings: 'agent' | 'user' | null
  shipTo: ShipToValue | null
  stages: Record<AutonomyStage, StageAutonomyValue | null>
}
