// concern: refusal

export type RefusalRemedy = { kind: 'command'; argv: string[] } | { kind: 'edit'; text: string }

export type Refusal = {
  condition: string
  remedy?: RefusalRemedy
  remedies?: readonly RefusalRemedy[]
}

/** Build a refusal while keeping its condition separate from an optional remedy. */
export function refusal(
  condition: string,
  remedy?: RefusalRemedy | readonly RefusalRemedy[],
): Refusal {
  if (Array.isArray(remedy)) return remedy.length ? { condition, remedies: remedy } : { condition }
  return remedy ? { condition, remedy: remedy as RefusalRemedy } : { condition }
}

function renderRemedy(remedy: RefusalRemedy): string {
  return remedy.kind === 'command' ? remedy.argv.join(' ') : remedy.text
}

/** Render the one operator-facing refusal form. */
export function renderRefusal(value: Refusal): string {
  const remedies = value.remedies ?? (value.remedy ? [value.remedy] : [])
  return [value.condition, ...remedies.map((remedy) => `cleared by: ${renderRemedy(remedy)}`)].join(
    '\n',
  )
}
