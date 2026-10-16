import type { Tone } from '@bottega/hub-ui/badge'

/** The tone for a run's verdict: any failing axis wins over a passing one. */
export function verdictTone(delivery: string | null, quality: string | null): Tone {
  if (quality === 'wrong' || delivery === 'none') return 'error'
  if (quality === 'mixed' || delivery === 'partial') return 'warning'
  if (quality === 'right' || delivery === 'full') return 'success'
  return 'neutral'
}
