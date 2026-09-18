const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export function compactTokens(value: number | null | undefined) {
  if (value == null) return '-'
  if (value >= 1e9) return `${compactNumber.format(value / 1e9)}B`
  if (value >= 1e6) return `${compactNumber.format(value / 1e6)}M`
  if (value >= 1e3) return `${compactNumber.format(value / 1e3)}K`
  return String(Math.round(value))
}
