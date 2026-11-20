// concern: launch-time filesystem adapter for the Codex literal deny policy

import { readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { realPathForPotentialPath } from '../../../shared/state-directory.ts'
import { codexDenyListingDirectories, type CodexDirectoryListing } from './codex-deny-policy.ts'
import {
  codexPermissionProfileInput,
  type CodexPermissionProfileInput,
  codexWritableRoots,
} from './codex-sandbox.ts'
import type { SandboxRuntimeConfig } from './sandbox.ts'

/** List the current filesystem and translate a fresh Codex profile for this launch. */
export function codexPermissionLaunchProfileInput(input: {
  profile: SandboxRuntimeConfig
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  cwd: string
  writableRoots: readonly string[]
  tempDir: string | undefined
  writesRepository: boolean
}): CodexPermissionProfileInput {
  const canonical = (path: string) => {
    try {
      return realPathForPotentialPath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EOPNOTSUPP') return resolve(path)
      throw error
    }
  }
  const profile = {
    ...input.profile,
    filesystem: {
      denyRead: input.profile.filesystem.denyRead.map(canonical),
      allowWithinDeny: input.profile.filesystem.allowWithinDeny.map(canonical),
      allowWrite: input.profile.filesystem.allowWrite.map(canonical),
      denyWrite: input.profile.filesystem.denyWrite.map(canonical),
    },
  }
  const cwd = canonical(input.cwd)
  const launchWritableRoots = input.writableRoots.map(canonical)
  const tempDir = input.tempDir === undefined ? undefined : canonical(input.tempDir)
  const writableRoots = input.writesRepository
    ? (codexWritableRoots(input.sandbox, cwd, launchWritableRoots, tempDir, true) ?? [])
    : profile.filesystem.allowWrite
  const protectedPaths = [cwd, ...writableRoots]
  const opaquePaths = profile.filesystem.allowWithinDeny.filter((allowed) =>
    writableRoots.some((writable) => {
      const rel = relative(allowed, writable)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    }),
  )
  const directoryListings: Record<string, readonly string[]> = {}
  for (const directory of codexDenyListingDirectories(
    profile.filesystem.denyRead,
    protectedPaths,
    opaquePaths,
  )) {
    try {
      directoryListings[directory] = readdirSync(directory)
    } catch (error) {
      throw new Error(
        `codex permission profile refusal: cannot list ${directory}; make every ancestor of cwd and the writable roots readable before launching Codex`,
        { cause: error },
      )
    }
  }
  return codexPermissionProfileInput({
    ...input,
    profile,
    cwd,
    writableRoots: launchWritableRoots,
    tempDir,
    directoryListings,
    opaquePaths,
  })
}

export type { CodexDirectoryListing }
