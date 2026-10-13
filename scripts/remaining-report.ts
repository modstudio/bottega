import { writeFileSync } from 'node:fs'

export function reportRemaining(path: string | undefined, remaining: number): void {
  if (path) writeFileSync(path, JSON.stringify({ remaining }))
}
