function compactValue(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value)
  return `[${value.map(compactValue).join(', ')}]`
}

function containsObject(value: unknown): boolean {
  if (!Array.isArray(value)) return typeof value === 'object' && value !== null
  return value.some(containsObject)
}

function render(value: unknown, level: number, prefixLength = 0): string {
  const indentation = '  '.repeat(level)
  if (Array.isArray(value)) {
    const compact = compactValue(value)
    if (!containsObject(value) && indentation.length + prefixLength + compact.length <= 100)
      return compact
    if (!value.length) return '[]'
    return `[\n${value.map((item) => `${'  '.repeat(level + 1)}${render(item, level + 1)}`).join(',\n')}\n${indentation}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    return `{\n${entries
      .map(([key, item]) => {
        const renderedKey = JSON.stringify(key)
        return `${'  '.repeat(level + 1)}${renderedKey}: ${render(item, level + 1, renderedKey.length + 2)}`
      })
      .join(',\n')}\n${indentation}}`
  }
  return JSON.stringify(value)
}

export const formatRecordClientContractJson = (value: unknown): string => `${render(value, 0)}\n`
