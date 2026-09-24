// concern: workflows
/** Resolves user-facing workflow step references without knowing workflow storage or execution. */

export type WorkflowModeStepList = {
  mode: string
  steps: readonly string[]
}

export function resolveWorkflowStepReference(
  reference: string,
  modeStepLists: readonly WorkflowModeStepList[],
): string {
  if (modeStepLists.some(({ steps }) => steps.includes(reference))) return reference
  if (!/^\d+$/.test(reference)) return reference

  const position = BigInt(reference)
  const maxPosition = modeStepLists.reduce(
    (largest, mode) => Math.max(largest, mode.steps.length),
    0,
  )
  if (position < 1n || position > BigInt(maxPosition)) {
    throw new Error(
      `workflow step position "${reference}" is out of range; valid range is 1-${maxPosition}`,
    )
  }

  const index = Number(position - 1n)
  const candidates = modeStepLists.flatMap(({ mode, steps }) => {
    const step = steps[index]
    return step === undefined ? [] : [{ mode, step }]
  })
  const slugs = new Set(candidates.map(({ step }) => step))
  if (slugs.size === 1) return candidates[0]!.step

  throw new Error(
    [
      `workflow step position "${reference}" is ambiguous across modes:`,
      ...candidates.map(({ mode, step }) => `- mode "${mode}": "${step}"`),
      'fix: pass a mode to select one',
    ].join('\n'),
  )
}
