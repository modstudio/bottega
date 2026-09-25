export function runRef(ref: string): { root: number; turn: number | null } | null {
  const match = ref.match(/^orch:(\d+)(?::turn:(\d+))?$/)
  if (!match) return null
  return { root: Number(match[1]), turn: match[2] ? Number(match[2]) : null }
}
