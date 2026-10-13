import type { ChangeEntry, ContentResult } from '../../../shared/change-view.ts'

export type SideFile = { path: string; content: Extract<ContentResult, { status: 'present' }> }

export function commandForSide(command: string[], files: string[], checkoutRoot: string): string[] {
  return command.flatMap((argument) => {
    if (argument === '{files}') return files
    return [argument.replaceAll('{root}', checkoutRoot)]
  })
}

export function sideFiles(
  entries: ChangeEntry[],
  side: 'base' | 'head',
  content: (path: string) => ContentResult,
): SideFile[] {
  return entries.flatMap((entry) => {
    if (side === 'head' && entry.status === 'D') return []
    if (side === 'base' && entry.status === 'A') return []
    const path = side === 'base' ? (entry.sourcePath ?? entry.path) : entry.path
    const result = content(entry.path)
    return result.status === 'present' ? [{ path, content: result }] : []
  })
}

export function supportPlacements(root: string, mirror: string, paths: string[]) {
  return paths.map((path) => ({ source: `${root}/${path}`, destination: `${mirror}/${path}` }))
}
