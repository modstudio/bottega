// concern: project-settings-patch
/** Owns pure JSON Merge Patch application and effect reporting. */

function mergeableObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Applies RFC 7386 JSON Merge Patch semantics: objects merge recursively,
 * arrays and other values replace, null removes a key, and omitted keys remain.
 */
export function mergeProjectSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const previous = out[key]
    out[key] =
      mergeableObject(value) && mergeableObject(previous)
        ? mergeProjectSettings(previous, value)
        : value
  }
  return out
}

export type SettingsPatchEffect = {
  added: string[]
  changed: string[]
  removed: string[]
}

/** Reports the dotted key paths changed between two project settings objects. */
export function settingsPatchEffect(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SettingsPatchEffect {
  const effect: SettingsPatchEffect = { added: [], changed: [], removed: [] }

  function visit(left: Record<string, unknown>, right: Record<string, unknown>, prefix = ''): void {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = prefix ? `${prefix}.${key}` : key
      const inLeft = Object.hasOwn(left, key)
      const inRight = Object.hasOwn(right, key)
      if (!inLeft) {
        effect.added.push(path)
        continue
      }
      if (!inRight) {
        effect.removed.push(path)
        continue
      }
      const leftValue = left[key]
      const rightValue = right[key]
      if (mergeableObject(leftValue) && mergeableObject(rightValue)) {
        visit(leftValue, rightValue, path)
      } else if (!Bun.deepEquals(leftValue, rightValue)) {
        effect.changed.push(path)
      }
    }
  }

  visit(before, after)
  effect.added.sort()
  effect.changed.sort()
  effect.removed.sort()
  return effect
}
