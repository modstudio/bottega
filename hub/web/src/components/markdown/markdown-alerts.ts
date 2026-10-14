import {
  type DefaultBuildType,
  type IAlert,
  type IOptions,
  rehypeGithubAlerts,
} from 'rehype-github-alerts'
import type { Tone } from '@/ui/badge/badge'

const ALERTS = {
  NOTE: { tone: 'info', title: 'Note' },
  TIP: { tone: 'success', title: 'Tip' },
  IMPORTANT: { tone: 'progress', title: 'Important' },
  WARNING: { tone: 'warning', title: 'Warning' },
  CAUTION: { tone: 'error', title: 'Caution' },
} as const satisfies Record<string, { tone: Tone; title: string }>

const TONES: readonly Tone[] = ['neutral', 'success', 'warning', 'error', 'info', 'progress']

export function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && TONES.includes(value as Tone)
}

/** Whether a blockquote's source is a GitHub alert the reader renders. */
export function isGithubAlertBlock(raw: string): boolean {
  const first = raw.split('\n').find((line) => line.trim() !== '')
  if (!first) return false
  const match = /^ {0,3}>[ \t]*\[!([A-Za-z]+)\]/.exec(first)
  if (!match) return false
  return Object.hasOwn(ALERTS, match[1]!.toUpperCase())
}

const build: DefaultBuildType = (alert, children) => {
  const mapped = ALERTS[alert.keyword.toUpperCase() as keyof typeof ALERTS]
  if (!mapped) return null
  return {
    type: 'element',
    tagName: 'div',
    properties: {
      dataCallout: mapped.title,
      dataTone: mapped.tone,
    },
    children,
  }
}

const alerts: IAlert[] = Object.entries(ALERTS).map(([keyword, value]) => ({
  keyword,
  icon: '',
  title: value.title,
}))

export const githubAlertPlugin: [typeof rehypeGithubAlerts, IOptions] = [
  rehypeGithubAlerts,
  { alerts, build, supportLegacy: false },
]
