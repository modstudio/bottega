/** Vocabulary accepted by every workflow-autonomy boundary. */
export const AUTONOMY_STAGES = ['plan', 'implement', 'review', 'docs', 'canon', 'ship'] as const
export const AUTONOMY_VALUES = ['ask', 'review', 'auto'] as const
export const AUTONOMY_PRESETS = ['manual', 'guided', 'autonomous'] as const

export type AutonomyStage = (typeof AUTONOMY_STAGES)[number]
export type AutonomyValue = (typeof AUTONOMY_VALUES)[number]
export type AutonomyPreset = (typeof AUTONOMY_PRESETS)[number]
