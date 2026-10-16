export type Shard = { index: number; total: number; value: string }

export function parseShard(value: string): Shard {
  const match = value.match(/^(\d+)\/(\d+)$/)
  if (!match) throw new Error('expected M/N')
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1 || index < 1 || index > total) {
    throw new Error('M and N must satisfy 1 <= M <= N')
  }
  return { index, total, value }
}
