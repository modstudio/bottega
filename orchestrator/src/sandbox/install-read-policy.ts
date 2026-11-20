// concern: running-install read carve-outs shared by SRT profiles and their executed probe.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import {
  runningInstallationKind,
  runningInstallRoot,
} from '../../../shared/install-root.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

type WorkspaceManifest = {
  workspaces?: string[] | { packages?: string[] }
}

export function runningInstallRootForSandbox(environment: ConfigEnvironment): string {
  return runningInstallRoot(import.meta.dir, environment)
}

/** Runtime paths needed to launch the CLI without exposing its checkout root. */
export function runningInstallReadCarveouts(environment: ConfigEnvironment): string[] {
  const root = runningInstallRootForSandbox(environment)
  if (runningInstallationKind(import.meta.dir, environment) === 'distribution') return [root]
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? [])
  return [
    ...new Set([
      join(root, 'bin'),
      join(root, 'cli'),
      join(root, 'node_modules'),
      manifestPath,
      ...workspaces.map((workspace) => resolve(root, workspace)),
    ]),
  ]
}

/** The running public CLI argv used by the cross-project confinement probe. */
export function runningBottegaEntryArgv(): string[] {
  return bottegaEntryArgv(PLATFORM_SLUG)
}
