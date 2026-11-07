// concern: refusal

export type RefusalRemedy =
  | { kind: 'command'; argv: string[] }
  | { kind: 'edit'; text: string }

export type Refusal = {
  condition: string
  remedy?: RefusalRemedy
}

/** Build a refusal while keeping its condition separate from an optional remedy. */
export function refusal(condition: string, remedy?: RefusalRemedy): Refusal {
  return remedy ? { condition, remedy } : { condition }
}

function renderRemedy(remedy: RefusalRemedy): string {
  return remedy.kind === 'command' ? remedy.argv.join(' ') : remedy.text
}

/** Render the one operator-facing refusal form. */
export function renderRefusal(value: Refusal): string {
  return value.remedy
    ? `${value.condition}\ncleared by: ${renderRemedy(value.remedy)}`
    : value.condition
}
