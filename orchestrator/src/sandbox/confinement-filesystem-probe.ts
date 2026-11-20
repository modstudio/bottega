// concern: executed confinement probe; owns disposable fixtures and real SRT launches.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBounded } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { runningBottegaEntryArgv, runningInstallRootForSandbox } from './install-read-policy.ts'
import { readonlyLensProfile, resetSandbox, sandboxLaunchArgv, writerProfile } from './sandbox.ts'

type FilesystemProbeAccess = 'denied' | 'readable' | 'not covered'
export type ConfinementFilesystemProbeRow = {
  family:
    | 'goose'
    | 'grok'
    | 'ACP writer'
    | 'cross-project CLI'
    | 'Codex'
    | 'read-only MCP'
    | 'host override'
  status: FilesystemProbeAccess
  paths: Record<string, FilesystemProbeAccess>
  reason?: string
}

async function launchCrossProjectCliProbe(
  profile: ReturnType<typeof readonlyLensProfile>,
): Promise<ConfinementFilesystemProbeRow> {
  try {
    const [bin, ...argv] = runningBottegaEntryArgv()
    await startBounded(await sandboxLaunchArgv(profile, bin!, [...argv, '--version']), {
      budget: 'sandbox-probe',
    })
    return {
      family: 'cross-project CLI',
      status: 'readable',
      paths: { [`${PLATFORM_SLUG} --version`]: 'readable', 'install .env': 'not covered' },
      reason:
        'real running install used; its CLI was executed, but no .env was planted in that checkout',
    }
  } catch {
    return {
      family: 'cross-project CLI',
      status: 'denied',
      paths: { [`${PLATFORM_SLUG} --version`]: 'denied', 'install .env': 'not covered' },
      reason: 'real running install used; its CLI failed, and no .env was planted in that checkout',
    }
  } finally {
    await resetSandbox()
  }
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
    const output = (await startBounded(argv, { budget: 'sandbox-probe' })).stdout
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
  const root = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-confinement-probe-`))
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
    const install = fixtureProject(
      'running-install',
      PLATFORM_SLUG,
      runningInstallRootForSandbox(environment),
    )
    const registeredProjects = [own, sibling, install]
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
      await launchCrossProjectCliProbe(readonlyLensProfile({ ...common, agent: 'grok' })),
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
