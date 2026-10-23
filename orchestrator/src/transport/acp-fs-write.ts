// concern: which root admits one ACP client-served file write, and serving it

import { writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { writingAcpDenyWrite } from '../sandbox/sandbox.ts'
import { confineFsPath, pathIsWithinRoot } from './transport.ts'

/** Where one ACP `fs/write_text_file` may land, or why no root admits it. */
export type AcpWriteAdmission =
  | { admitted: true; root: string }
  | { admitted: false; reason: 'no-root' | 'outside' | 'sandbox-denied' }

/**
 * The paths the run's sandbox profile denies writes to. A writing run reads the
 * writer profile's deny list from its one source, `writingAcpDenyWrite`; a
 * read-only run carries no writer denials. Callers may pass an explicit list
 * (the profile's own) instead of the default.
 */
function denyWriteFor(input: {
  writing: boolean
  worktree: string | null | undefined
  denyWrite?: string[]
}): string[] {
  if (input.denyWrite) return input.denyWrite
  return input.writing && input.worktree ? writingAcpDenyWrite(input.worktree) : []
}

/** Whether a resolved path sits at or below any sandbox-denied entry. */
function withinAnyDeny(path: string, denyWrite: string[]): boolean {
  return denyWrite.some((denied) => pathIsWithinRoot(path, resolve(denied)))
}

/**
 * Which root admits one ACP `fs/write_text_file`: a writing run may write inside
 * its run worktree as well as inside its scratch directory, and a read-only run
 * writes only into scratch. A path the run's sandbox profile denies is refused
 * whatever root would otherwise admit it. The decision is lexical over plain
 * values; the caller confines the admitted root with `confineFsPath`, whose
 * realpath resolution is what refuses a symlink out of that root.
 */
export function acpWriteAdmission(input: {
  writing: boolean
  worktree: string | null | undefined
  scratch: string | null | undefined
  path: string
  denyWrite?: string[]
}): AcpWriteAdmission {
  const candidates = [input.writing ? input.worktree : null, input.scratch].filter(
    (root): root is string => Boolean(root),
  )
  if (candidates.length === 0) return { admitted: false, reason: 'no-root' }
  const denyWrite = denyWriteFor(input)
  for (const root of candidates) {
    const normalizedRoot = normalize(root)
    const candidate = normalize(
      isAbsolute(input.path) ? input.path : join(normalizedRoot, input.path),
    )
    if (pathIsWithinRoot(candidate, normalizedRoot)) {
      if (withinAnyDeny(candidate, denyWrite)) return { admitted: false, reason: 'sandbox-denied' }
      return { admitted: true, root }
    }
  }
  return { admitted: false, reason: 'outside' }
}

/** The refusal message for one admission failure, in the same shape as before. */
function acpWriteRefusal(reason: 'no-root' | 'outside' | 'sandbox-denied', path: string): Error {
  if (reason === 'no-root')
    return new Error('ACP fs.writeTextFile refused: BOTTEGA_SCRATCH is not set')
  if (reason === 'sandbox-denied')
    return new Error(`ACP fs.writeTextFile refused: ${path} is sandbox-denied`)
  return new Error(`ACP fs.writeTextFile refused: ${path} is outside the allowed root`)
}

/**
 * Serve one ACP `fs/write_text_file` through `acpWriteAdmission`, then confine
 * the admitted root by realpath prefix and refuse any sandbox-denied path before
 * writing. The realpath check catches a denial reached through a symlink.
 */
export function writeAcpFile(input: {
  writingAcp: boolean
  worktree: string
  scratch: string | undefined
  path: string
  content: string
  denyWrite?: string[]
}): void {
  const admission = acpWriteAdmission({
    writing: input.writingAcp,
    worktree: input.worktree,
    scratch: input.scratch,
    path: input.path,
    denyWrite: input.denyWrite,
  })
  if (!admission.admitted) throw acpWriteRefusal(admission.reason, input.path)
  const confined = confineFsPath(input.path, admission.root, 'writeTextFile')
  const denyWrite = denyWriteFor({
    writing: input.writingAcp,
    worktree: input.worktree,
    denyWrite: input.denyWrite,
  })
  if (withinAnyDeny(confined, denyWrite)) throw acpWriteRefusal('sandbox-denied', input.path)
  writeFileSync(confined, input.content)
}
