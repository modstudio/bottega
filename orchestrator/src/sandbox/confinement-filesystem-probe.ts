// concern: executed confinement probe; owns disposable fixtures and real SRT launches.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV, resolveStatePaths } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { readonlyLensProfile, resetSandbox, sandboxLaunchArgv, writerProfile } from './sandbox.ts'

export type FilesystemProbeAccess = 'denied' | 'readable' | 'not covered'
export type ConfinementFilesystemProbeRow = {
  family: 'goose' | 'grok' | 'ACP writer' | 'Codex' | 'read-only MCP' | 'host override'
  status: FilesystemProbeAccess
  paths: Record<string, FilesystemProbeAccess>
  reason?: string
}

const NOT_COVERED: ConfinementFilesystemProbeRow[] = [
  { family: 'Codex', status: 'not covered', paths: {}, reason: 'Codex has no SRT read profile' },
  {
    family: 'read-only MCP',
    status: 'not covered',
    paths: {},
    reason: 'read-only MCP runs on the host',
  },
  {
    family: 'host override',
    status: 'not covered',
    paths: {},
    reason: 'BOTTEGA_SANDBOX=host bypasses SRT',
  },
]

function fixtureProject(
  recordId: string,
  name: string,
  path: string,
  secretPaths: string[] = [],
): Project {
  return {
    recordId,
    name,
    path,
    stack: 'probe',
    canon: false,
    retiredAt: null,
    settings: { secretPaths },
  }
}

async function launchProbe(
  family: 'goose' | 'grok' | 'ACP writer',
  profile: ReturnType<typeof readonlyLensProfile>,
  targets: readonly [string, string][],
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const script =
      'for path\ndo\nif /bin/cat "$path" >/dev/null 2>&1; then echo readable; else echo denied; fi\ndone'
    const argv = await sandboxLaunchArgv(profile, '/bin/sh', [
      '-c',
      script,
      'probe',
      ...targets.map(([, path]) => path),
    ])
    const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stdout).text()
    await child.exited
    const values = output.trim().split(/\r?\n/) as FilesystemProbeAccess[]
    const paths = Object.fromEntries(
      targets.map(([name], index) => [name, values[index] ?? 'denied']),
    )
    const protectedNames = ['sibling .env', 'sibling .mcp.json', 'orchestrator store', 'own secret']
    const readableNames = ['own tree', 'own .git objects']
    const passed =
      protectedNames.every((name) => paths[name] === 'denied') &&
      readableNames.every((name) => paths[name] === 'readable')
    return { family, status: passed ? 'denied' : 'readable', paths }
  } finally {
    await resetSandbox()
  }
}

/** Execute each SRT profile family against planted sibling, state, secret, and own-tree paths. */
export async function runConfinementFilesystemProbes(): Promise<ConfinementFilesystemProbeRow[]> {
  const root = mkdtempSync(join(tmpdir(), 'bottega-confinement-probe-'))
  try {
    const ownPath = join(root, 'projects', 'own')
    const worktree = join(root, 'worktrees', 'own')
    const siblingPath = join(root, 'projects', 'sibling')
    const stateRoot = join(root, 'state')
    const environment = { HOME: join(root, 'home'), [STATE_HOME_ENV]: stateRoot }
    const state = resolveStatePaths(environment)
    const runtimeDir = join(state.orchestratorRuns, 'sandbox-probe')
    const scratchDir = join(state.orchestratorRuns, 'probe', 'scratch')
    const own = fixtureProject('own', 'own', ownPath, ['declared.secret'])
    const sibling = fixtureProject('sibling', 'sibling', siblingPath)
    const registeredProjects = [own, sibling]
    const planted = {
      'sibling .env': join(siblingPath, '.env'),
      'sibling .mcp.json': join(siblingPath, '.mcp.json'),
      'orchestrator store': state.orchestratorDatabase,
      'own secret': join(ownPath, 'declared.secret'),
      'own tree': join(worktree, 'visible.txt'),
      'own .git objects': join(ownPath, '.git', 'objects', 'visible'),
    }
    for (const path of Object.values(planted)) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'fixture')
    }
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(scratchDir, { recursive: true })
    mkdirSync(state.hubDirectory, { recursive: true })
    writeFileSync(state.hubDatabase, '')
    const common = {
      worktree,
      runtimeDir,
      scratchDir,
      project: own,
      registeredProjects,
      path: '/bin:/usr/bin',
      nodeModuleLinks: [],
      environment,
      socketDenyPaths: [],
    }
    const targets = Object.entries(planted)
    return [
      await launchProbe('goose', readonlyLensProfile({ ...common, agent: 'goose' }), targets),
      await launchProbe('grok', readonlyLensProfile({ ...common, agent: 'grok' }), targets),
      await launchProbe(
        'ACP writer',
        writerProfile({ ...common, agent: 'grok', askAddress: '127.0.0.1:1' }),
        targets,
      ),
      ...NOT_COVERED,
    ]
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export function formatConfinementFilesystemProbes(
  rows: readonly ConfinementFilesystemProbeRow[],
): string[] {
  return rows.map((row) =>
    row.status === 'not covered'
      ? `filesystem-probe  ${row.family}  not covered: ${row.reason}`
      : `filesystem-probe  ${row.family}  ${row.status}  ${Object.entries(row.paths)
          .map(([name, access]) => `${name}=${access}`)
          .join(' ')}`,
  )
}
