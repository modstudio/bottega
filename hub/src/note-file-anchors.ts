// concern: note-file-anchors
/** Reads bounded, checkout-confined source lines for note provenance. */

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'

export const NOTE_ANCHOR_MAX_FILE_BYTES = 1_000_000

function boundedNoteLine(path: string, requested: number): string | null {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > NOTE_ANCHOR_MAX_FILE_BYTES) return null
    const bytes: number[] = []
    const byte = Buffer.allocUnsafe(1)
    let line = 1
    let total = 0
    while (readSync(fd, byte, 0, 1, null) === 1) {
      total += 1
      if (total > NOTE_ANCHOR_MAX_FILE_BYTES) return null
      if (byte[0] === 10) {
        if (line === requested) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
        line += 1
        continue
      }
      if (line === requested) bytes.push(byte[0]!)
    }
    return line === requested ? Buffer.from(bytes).toString('utf8').replace(/\r$/, '') : null
  } finally {
    closeSync(fd)
  }
}

export function deriveNoteFileAnchors(text: string, projectPath: string): NoteAnchorWire['files'] {
  let root: string
  try {
    root = realpathSync(projectPath)
  } catch {
    return []
  }
  return [...text.matchAll(/(?:^|[\s`(])([^\s`():]+):(\d+)\b/g)].flatMap((match) => {
    const line = Number(match[2])
    let path: string
    try {
      path = realpathSync(isAbsolute(match[1]!) ? match[1]! : resolve(root, match[1]!))
    } catch {
      return []
    }
    const fromRoot = relative(root, path)
    if (
      !fromRoot ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    )
      return []
    try {
      const content = boundedNoteLine(path, line)
      return content === null ? [] : [{ path, line, content }]
    } catch {
      return []
    }
  })
}
