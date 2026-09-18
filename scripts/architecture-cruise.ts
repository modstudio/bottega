import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencyCruiserConfig } from './architecture.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

export const ARCHITECTURE_CRUISE_ROOTS = [
  'orchestrator',
  'hub',
  'shared',
  'ops',
  'local-stack',
  'retrieval',
  'scripts',
] as const

type ArchitectureCruiseRequest = {
  entries: readonly string[]
  extraArgs?: string[]
  stdout?: 'pipe' | 'inherit'
}

export async function runArchitectureCruise(request: ArchitectureCruiseRequest) {
  const generatedDirectory = mkdtempSync(join(tmpdir(), 'architecture-'))
  const generatedConfig = join(generatedDirectory, 'dependency-cruiser.json')
  writeFileSync(generatedConfig, JSON.stringify(dependencyCruiserConfig()))
  try {
    const stdout = request.stdout ?? 'inherit'
    const child = Bun.spawn(
      [
        join(ROOT, 'node_modules/.bin/depcruise'),
        '--validate',
        join(ROOT, '.dependency-cruiser.cjs'),
        ...(request.extraArgs ?? []),
        ...request.entries,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, ARCHITECTURE_CONFIG: generatedConfig },
        stdout,
        stderr: 'inherit',
      },
    )
    const output = stdout === 'pipe' ? await new Response(child.stdout).text() : ''
    return { exitCode: await child.exited, stdout: output }
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}
