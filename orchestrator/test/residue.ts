/** Paired release for exact scratch paths provisioned by a test file. */
import { afterEach } from 'bun:test'
import { rmSync } from 'node:fs'

export function trackedTestResidue(): (path: string) => string {
  const paths = new Set<string>()
  afterEach(() => {
    for (const path of paths) rmSync(path, { recursive: true, force: true })
    paths.clear()
  })
  return (path) => {
    paths.add(path)
    return path
  }
}
