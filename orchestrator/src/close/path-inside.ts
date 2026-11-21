import { resolve } from 'node:path'

export function isPathInside(candidate: string | null, directory: string): boolean {
  if (!candidate) return false
  const path = resolve(candidate)
  const root = resolve(directory)
  return path === root || path.startsWith(`${root}/`)
}
