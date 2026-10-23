// concern: codex throttle classification
/** Purely recognizes Codex's two live 429 retry announcements. */

export type CodexThrottle = {
  attempt: number
  max: number
  retryDelayMs: number | null
  status: 429
}

const CODEX_THROTTLE_NOTICE = 'Codex throttled: 429 Too Many Requests'

export function composeCodexThrottleNotice(
  throttle: Pick<CodexThrottle, 'attempt' | 'max'>,
): string {
  return `${CODEX_THROTTLE_NOTICE} (retry ${throttle.attempt}/${throttle.max})`
}

export function isCodexThrottleNotice(value: string): boolean {
  return new RegExp(`^${CODEX_THROTTLE_NOTICE} \\(retry \\d+/\\d+\\)$`).test(value)
}

function attemptFrom(text: string): { attempt: number; max: number } | null {
  const match = text.match(/(?:retrying sampling request\s*\(|Reconnecting\.\.\.\s+)(\d+)\/(\d+)/i)
  if (!match) return null
  const attempt = Number(match[1])
  const max = Number(match[2])
  return Number.isInteger(attempt) && Number.isInteger(max) && attempt > 0 && max > 0
    ? { attempt, max }
    : null
}

export function classifyCodexThrottle(line: string): CodexThrottle | null {
  let text = line
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as { type?: unknown; message?: unknown }
      if (value.type !== 'error' || typeof value.message !== 'string') return null
      text = value.message
    } catch {
      return null
    }
  }
  if (!/\b429\b|Too Many Requests/i.test(text)) return null
  const attempt = attemptFrom(text)
  if (!attempt) return null
  const delay = text.match(/\bin\s+(\d+(?:\.\d+)?)s\b/i)
  return {
    ...attempt,
    retryDelayMs: delay ? Math.round(Number(delay[1]) * 1000) : null,
    status: 429,
  }
}
