// concern: release-required
/** Computes the runtime module closure of release image entry points. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'

type Metafile = {
  inputs?: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>
}

type PackageManifest = {
  name?: string
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export function closureFromMetafile(
  root: string,
  cwd: string,
  metafile: Metafile,
  workspaceNames: ReadonlySet<string>,
): Set<string> {
  const paths = new Set<string>()
  for (const [input, detail] of Object.entries(metafile.inputs ?? {})) {
    for (const imported of detail.imports ?? []) {
      const workspace = [...workspaceNames].find(
        (name) => imported.path === name || imported.path.startsWith(`${name}/`),
      )
      if (imported.external && workspace) {
        throw new Error(`workspace import ${imported.path} from ${input} was externalized`)
      }
    }
    const repositoryPath = relative(root, resolve(cwd, input))
    if (
      repositoryPath !== '' &&
      !isAbsolute(repositoryPath) &&
      repositoryPath !== '..' &&
      !repositoryPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      paths.add(repositoryPath.replaceAll('\\', '/'))
    }
  }
  return paths
}

function manifestAt(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

export function workspaceExternals(root: string): {
  names: Map<string, string>
  externals: string[]
} {
  const rootManifest = manifestAt(join(root, 'package.json'))
  const manifests: PackageManifest[] = [rootManifest]
  const names = new Map<string, string>()
  for (const directory of rootManifest.workspaces ?? []) {
    const manifest = manifestAt(join(root, directory, 'package.json'))
    manifests.push(manifest)
    if (manifest.name) names.set(manifest.name, directory)
  }
  const externals = new Set<string>()
  for (const manifest of manifests) {
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      for (const name of Object.keys(dependencies ?? {})) externals.add(name)
    }
  }
  for (const name of names.keys()) externals.delete(name)
  return { names, externals: [...externals] }
}

function spawnOrThrow(command: string[], cwd: string, detail: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    throw new Error(`${detail}: ${stderr || `exit ${result.exitCode}`}`)
  }
}

export function entryClosureAtCommit(
  project: Project,
  commit: string,
  entries: readonly string[],
): Map<string, Set<string>> {
  const directory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-release-entry-`))
  const tree = join(directory, 'tree')
  try {
    mkdirSync(tree)
    git(
      ['archive', '--format=tar', '-o', join(directory, 'tree.tar'), commit],
      project.path,
      targetGitEnvironment(project.path),
      ` while archiving release entry tree at ${commit}`,
    )
    spawnOrThrow(
      ['tar', '-xf', join(directory, 'tree.tar'), '-C', tree],
      project.path,
      `tar failed while extracting release entry tree at ${commit}`,
    )
    const workspace = workspaceExternals(tree)
    for (const [name, workspaceDirectory] of workspace.names) {
      const link = join(tree, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(tree, workspaceDirectory), link, 'dir')
    }
    const closure = new Map<string, Set<string>>()
    for (const [index, entry] of entries.entries()) {
      const entryPath = join(tree, entry)
      if (!existsSync(entryPath)) throw new Error(`release entry ${entry} does not exist`)
      const metafilePath = join(directory, `meta-${index}.json`)
      const externalArgs = workspace.externals.flatMap((name) => [
        '--external',
        name,
        '--external',
        `${name}/*`,
      ])
      spawnOrThrow(
        [
          'bun',
          'build',
          entryPath,
          '--target=bun',
          `--outdir=${join(directory, 'out')}`,
          `--metafile=${metafilePath}`,
          ...externalArgs,
        ],
        tree,
        `release entry ${entry} failed to build`,
      )
      const metafile = JSON.parse(readFileSync(metafilePath, 'utf8')) as Metafile
      closure.set(entry, closureFromMetafile(tree, tree, metafile, new Set(workspace.names.keys())))
    }
    return closure
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
