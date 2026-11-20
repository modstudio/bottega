#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repositoryDockerfiles } from './repository-dockerfiles.ts'
import { REPOSITORY_ROOT_DATA_IMPORTS } from './repository-root-data-imports.ts'

type DockerfileText = { path: string; text: string }

export type DockerWorkspaceInputs = {
  workspaces: string[]
  patchedDependencies: string[]
  dockerfiles: DockerfileText[]
  dockerignore: string
  rootDataImports: readonly string[]
}

type DockerInstruction = { keyword: string; body: string; line: number }

function dockerInstructions(text: string): DockerInstruction[] {
  const instructions: DockerInstruction[] = []
  let pending = ''
  let instructionLine = 0
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!pending && (!trimmed || trimmed.startsWith('#'))) continue
    if (!pending) instructionLine = index + 1
    const continued = trimmed.endsWith('\\')
    pending += `${pending ? ' ' : ''}${continued ? trimmed.slice(0, -1).trimEnd() : trimmed}`
    if (continued) continue
    const instruction = pending.match(/^([a-z]+)\s+(.+)$/i)
    if (instruction) {
      instructions.push({
        keyword: instruction[1]!.toUpperCase(),
        body: instruction[2]!,
        line: instructionLine,
      })
    }
    pending = ''
  }
  return instructions
}

function copySources(body: string): string[] {
  const withoutFlags = body.replace(/^(?:--\S+\s+)*/, '')
  if (withoutFlags.startsWith('[')) {
    try {
      const paths = JSON.parse(withoutFlags) as unknown
      return Array.isArray(paths) && paths.every((path) => typeof path === 'string')
        ? paths.slice(0, -1)
        : []
    } catch {
      return []
    }
  }
  return withoutFlags.split(/\s+/).slice(0, -1)
}

function copiedSourcesAtInstalls(text: string): { line: number; sources: Set<string> }[] {
  const installs: { line: number; sources: Set<string> }[] = []
  let sources = new Set<string>()
  for (const instruction of dockerInstructions(text)) {
    if (instruction.keyword === 'FROM') {
      sources = new Set()
    } else if (instruction.keyword === 'COPY') {
      for (const source of copySources(instruction.body)) sources.add(source)
    } else if (instruction.keyword === 'RUN' && /\bbun\s+install\b/.test(instruction.body)) {
      installs.push({ line: instruction.line, sources: new Set(sources) })
    }
  }
  return installs
}

function reIncludedPaths(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('!'))
      .map((line) => line.slice(1)),
  )
}

function copiedSourceCoversPath(source: string, path: string): boolean {
  const normalizedSource = source.replace(/^\.\//, '').replace(/\/$/, '')
  return (
    normalizedSource === '.' || path === normalizedSource || path.startsWith(`${normalizedSource}/`)
  )
}

function copiedPatchFindings(dockerfile: DockerfileText, patchedDependencies: string[]): string[] {
  const findings: string[] = []
  for (const install of copiedSourcesAtInstalls(dockerfile.text)) {
    for (const patch of patchedDependencies) {
      if (![...install.sources].some((source) => copiedSourceCoversPath(source, patch))) {
        findings.push(
          `${dockerfile.path}:${install.line}: missing patched dependency ${patch}; add before bun install: COPY ${patch} ${patch}`,
        )
      }
    }
  }
  return findings
}

function dockerfileFindings(dockerfile: DockerfileText, workspaces: string[]): string[] {
  const findings: string[] = []
  const installs = copiedSourcesAtInstalls(dockerfile.text)
  for (const install of installs) {
    for (const workspace of workspaces) {
      const manifest = `${workspace}/package.json`
      if (!install.sources.has(manifest)) {
        const location =
          installs.length > 1 ? `${dockerfile.path}:${install.line}` : dockerfile.path
        findings.push(
          `${location}: missing workspace ${workspace}; add before bun install: COPY ${manifest} ${manifest}`,
        )
      }
    }
  }
  return findings
}

/** Decide whether install-stage manifests, patched dependencies, and root data stay complete. */
export function decideDockerWorkspaces(inputs: DockerWorkspaceInputs): string[] {
  const findings = inputs.dockerfiles.flatMap((dockerfile) => [
    ...dockerfileFindings(dockerfile, inputs.workspaces),
    ...copiedPatchFindings(dockerfile, inputs.patchedDependencies),
  ])

  const included = reIncludedPaths(inputs.dockerignore)
  for (const workspace of inputs.workspaces) {
    const manifest = `${workspace}/package.json`
    if (!included.has(manifest)) {
      findings.push(`.dockerignore: missing workspace ${workspace}; add: !${manifest}`)
    }
  }
  for (const file of inputs.rootDataImports) {
    if (!included.has(file)) {
      findings.push(`.dockerignore: missing root data import ${file}; add: !${file}`)
    }
  }
  for (const patch of inputs.patchedDependencies) {
    if (![...included].some((path) => copiedSourceCoversPath(path, patch))) {
      findings.push(`.dockerignore: excludes patched dependency ${patch}; add: !${patch}`)
    }
  }
  return findings
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    workspaces?: string[]
    patchedDependencies?: Record<string, string>
  }
  const dockerfiles = repositoryDockerfiles(root).map((path) => ({
    path,
    text: readFileSync(resolve(root, path), 'utf8'),
  }))
  const findings = decideDockerWorkspaces({
    workspaces: rootPackage.workspaces ?? [],
    patchedDependencies: Object.values(rootPackage.patchedDependencies ?? {}),
    dockerfiles,
    dockerignore: readFileSync(resolve(root, '.dockerignore'), 'utf8'),
    rootDataImports: REPOSITORY_ROOT_DATA_IMPORTS,
  })
  if (findings.length) {
    console.error('docker workspace check failed')
    for (const finding of findings) console.error(finding)
    process.exit(1)
  }
  console.log(
    `docker workspace manifests, patched dependencies, and root data check passed (${dockerfiles.length} Dockerfiles)`,
  )
}
