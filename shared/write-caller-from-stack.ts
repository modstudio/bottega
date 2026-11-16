/** Pure stack parsing that names the first repository frame outside the supplied sources. */

import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type WriteCallerOptions = {
  repositoryRoot: string
  excludedFiles?: readonly string[]
  excludedDirectories?: readonly string[]
}

function isWithin(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path)
  return fromDirectory === '' || (!fromDirectory.startsWith('..') && !isAbsolute(fromDirectory))
}

export function writeCallerFromStack(stack: string, options: WriteCallerOptions): string | null {
  const repositoryRoot = resolve(options.repositoryRoot)
  const excludedFiles = new Set((options.excludedFiles ?? []).map((path) => resolve(path)))
  const excludedDirectories = (options.excludedDirectories ?? []).map((path) => resolve(path))
  for (const line of stack.split('\n').slice(1)) {
    const suffix = line.match(/:(\d+):\d+\)?\s*$/)
    if (!suffix?.[1] || suffix.index === undefined) continue
    let framedPath = line.slice(0, suffix.index).trim()
    const wrapped = framedPath.match(/^at\s+.+?\s+\((.*)$/)
    framedPath = wrapped?.[1] ?? framedPath.replace(/^at\s+/, '')
    let path: string
    try {
      path = framedPath.startsWith('file://') ? fileURLToPath(framedPath) : framedPath
    } catch {
      continue
    }
    if (!isAbsolute(path)) continue
    const resolvedPath = resolve(path)
    if (!isWithin(repositoryRoot, resolvedPath)) continue
    if (excludedFiles.has(resolvedPath)) continue
    if (excludedDirectories.some((directory) => isWithin(directory, resolvedPath))) continue
    return `${relative(repositoryRoot, resolvedPath)}:${suffix[1]}`
  }
  return null
}
