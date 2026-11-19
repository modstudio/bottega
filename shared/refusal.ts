// concern: refusal

export type RefusalRemedy = { kind: 'command'; argv: string[] } | { kind: 'edit'; text: string }

export type Refusal = {
  condition: string
  remedies: readonly RefusalRemedy[]
}

/** Build a refusal while keeping its condition separate from an optional remedy. */
export function refusal(
  condition: string,
  remedy?: RefusalRemedy | readonly RefusalRemedy[],
): Refusal {
  return {
    condition,
    remedies: Array.isArray(remedy) ? remedy : remedy ? [remedy as RefusalRemedy] : [],
  }
}

function renderRemedy(remedy: RefusalRemedy): string {
  return remedy.kind === 'command' ? remedy.argv.join(' ') : remedy.text
}

/** Render the one operator-facing refusal form. */
export function renderRefusal(value: Refusal): string {
  return [
    value.condition,
    ...value.remedies.map((remedy) => `cleared by: ${renderRemedy(remedy)}`),
  ].join('\n')
}
