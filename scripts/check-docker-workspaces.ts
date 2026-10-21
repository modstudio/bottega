#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

type DockerfileText = { path: string; text: string }

export type DockerWorkspaceInputs = {
  workspaces: string[]
  dockerfiles: DockerfileText[]
  dockerignore: string
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

/** Decide whether install-stage manifests stay complete when the workspace list changes. */
export function decideDockerWorkspaces(inputs: DockerWorkspaceInputs): string[] {
  const findings = inputs.dockerfiles.flatMap((dockerfile) =>
    dockerfileFindings(dockerfile, inputs.workspaces),
  )

  const included = reIncludedPaths(inputs.dockerignore)
  for (const workspace of inputs.workspaces) {
    const manifest = `${workspace}/package.json`
    if (!included.has(manifest)) {
      findings.push(`.dockerignore: missing workspace ${workspace}; add: !${manifest}`)
    }
  }
  return findings
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    workspaces?: string[]
  }
  const dockerfiles = [...new Glob('**/Dockerfile').scanSync({ cwd: root, onlyFiles: true })]
    .filter((path) => !path.startsWith('node_modules/'))
    .sort()
    .map((path) => ({ path, text: readFileSync(resolve(root, path), 'utf8') }))
  const findings = decideDockerWorkspaces({
    workspaces: rootPackage.workspaces ?? [],
    dockerfiles,
    dockerignore: readFileSync(resolve(root, '.dockerignore'), 'utf8'),
  })
  if (findings.length) {
    console.error('docker workspace check failed')
    for (const finding of findings) console.error(finding)
    process.exit(1)
  }
  console.log(`docker workspace check passed (${dockerfiles.length} Dockerfiles)`)
}
