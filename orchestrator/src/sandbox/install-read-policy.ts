// concern: running-install read carve-outs shared by SRT profiles and their executed probe.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { runningInstallationKind, runningInstallRoot } from '../../../shared/install-root.ts'

type WorkspaceManifest = {
  workspaces?: string[] | { packages?: string[] }
}

export type RunningInstallLayout = {
  kind: 'distribution' | 'checkout'
  root: string
  workspaceDirectories: string[]
}

export function runningInstallRootForSandbox(environment: ConfigEnvironment): string {
  return runningInstallRoot(import.meta.dir, environment)
}

/** Gather the running installation layout, adding a remedy to malformed-manifest failures. */
export function resolveRunningInstallLayout(environment: ConfigEnvironment): RunningInstallLayout {
  const root = runningInstallRootForSandbox(environment)
  if (runningInstallationKind(import.meta.dir, environment) === 'distribution') {
    return { kind: 'distribution', root, workspaceDirectories: [] }
  }
  const manifestPath = join(root, 'package.json')
  let manifest: WorkspaceManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest
  } catch (error) {
    throw new Error(
      `cannot read running install manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}; repair or reinstall the running ${root}`,
    )
  }
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? [])
  return {
    kind: 'checkout',
    root,
    workspaceDirectories: workspaces.map((workspace) => resolve(root, workspace)),
  }
}

/** Runtime paths needed to launch the CLI without exposing its checkout root. */
export function runningInstallReadCarveouts(layout: RunningInstallLayout): string[] {
  if (layout.kind === 'distribution') return [layout.root]
  const root = layout.root
  return [
    ...new Set([
      join(root, 'bin'),
      join(root, 'cli'),
      join(root, 'shared'),
      join(root, 'node_modules'),
      join(root, 'package.json'),
      ...layout.workspaceDirectories,
    ]),
  ]
}
