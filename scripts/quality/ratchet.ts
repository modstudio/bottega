export type Finding = {
  file: string
  line: number
  rule: string
  message: string
}

export function normalizedMessage(message: string) {
  return message.replace(/\d+/g, '#')
}

export function fingerprint(finding: Finding) {
  return JSON.stringify([
    finding.file,
    finding.rule,
    normalizedMessage(finding.message),
  ])
}

export function introducedFindings(base: Finding[], head: Finding[]) {
  const remaining = new Map<string, number>()
  for (const finding of base) {
    const key = fingerprint(finding)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  return head.filter((finding) => {
    const key = fingerprint(finding)
    const count = remaining.get(key) ?? 0
    if (count === 0) return true
    remaining.set(key, count - 1)
    return false
  })
}
