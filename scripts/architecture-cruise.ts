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
  'cli',
  'scripts',
] as const

type ArchitectureCruiseRequest = {
  entries: readonly string[]
  extraArgs?: string[]
  stdout?: 'pipe' | 'inherit'
  config?: ReturnType<typeof dependencyCruiserConfig>
  cwd?: string
  timeoutMs?: number
}

export async function runArchitectureCruise(request: ArchitectureCruiseRequest) {
  const generatedDirectory = mkdtempSync(join(tmpdir(), 'architecture-'))
  const generatedConfig = join(generatedDirectory, 'dependency-cruiser.json')
  writeFileSync(generatedConfig, JSON.stringify(request.config ?? dependencyCruiserConfig()))
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
        cwd: request.cwd ?? ROOT,
        env: { ...process.env, ARCHITECTURE_CONFIG: generatedConfig },
        stdout,
        stderr: 'inherit',
      },
    )
    let timedOut = false
    const timeout =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, request.timeoutMs)
    try {
      const [output, exitCode] = await Promise.all([
        stdout === 'pipe' ? new Response(child.stdout).text() : Promise.resolve(''),
        child.exited,
      ])
      return { exitCode, stdout: output, timedOut }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}
