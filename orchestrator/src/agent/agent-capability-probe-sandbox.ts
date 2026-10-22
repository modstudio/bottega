// concern: registration capability probe sandbox lifecycle
/** Owns the disposable worktree, ask listener, sandbox selection, and teardown shared by capability probes. */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import type { Project } from '../project/projects.ts'
import {
  resetSandbox,
  type SandboxRuntimeConfig,
  selectReadonlySandbox,
} from '../sandbox/sandbox.ts'
import type { Agent } from './agents.ts'

export type CapabilityProbeConfinement = { cwd: string; profile: SandboxRuntimeConfig }
type CapabilityProbeAskListener = { address: string; close(): void | Promise<void> }

export type CapabilityProbeSandboxPorts = {
  createWorktree(path: string): void
  removeWorktree(path: string): void
  openAskListener(): CapabilityProbeAskListener
  resetSandbox(): Promise<void>
}

export type CapabilityProbeSandboxInput = {
  transport: 'cli' | 'acp'
  scratch: string
  agent: Agent
  path?: string
  environment: ConfigEnvironment
}

function createScratchGitWorktree(path: string): void {
  mkdirSync(path, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', '--quiet', path], {
    env: scrubbedGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) {
    throw new Error(
      `registration capability probe could not create its git worktree: ${initialized.stderr.toString().trim() || `git init exited ${initialized.exitCode ?? 'unknown'}`}`,
    )
  }
}

function probeProject(worktree: string): Project {
  return {
    recordId: 'registration-probe',
    name: 'registration-probe',
    path: worktree,
    stack: null,
    canon: false,
    retiredAt: null,
    settings: {},
  }
}

function openProbeAskListener(): CapabilityProbeAskListener {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  })
  return {
    address: `127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  }
}

export async function withCapabilityProbeSandbox<T>(
  input: CapabilityProbeSandboxInput,
  ports: CapabilityProbeSandboxPorts,
  operation: (confinement: CapabilityProbeConfinement) => Promise<T>,
): Promise<T> {
  const worktree = join(input.scratch, 'writing-worktree')
  let askListener: CapabilityProbeAskListener | null = null
  try {
    ports.createWorktree(worktree)
    askListener = ports.openAskListener()
    const selection = selectReadonlySandbox({
      agent: input.agent.name,
      readsRepo: true,
      writesRepo: true,
      worktree,
      runsDir: input.scratch,
      scratchDir: input.scratch,
      project: probeProject(worktree),
      path: input.path,
      baseUrl: input.agent.baseUrl,
      environment: input.environment,
      writingAcp: true,
      askAddress: askListener.address,
    })
    if (!selection.profile) throw new Error('registration capability probe did not select srt')
    return await operation({ cwd: worktree, profile: selection.profile })
  } finally {
    try {
      await ports.resetSandbox()
    } finally {
      try {
        await askListener?.close()
      } finally {
        ports.removeWorktree(worktree)
      }
    }
  }
}

export function capabilityProbeSandboxPorts(): CapabilityProbeSandboxPorts {
  return {
    createWorktree: createScratchGitWorktree,
    removeWorktree: (path) => rmSync(path, { recursive: true, force: true }),
    openAskListener: openProbeAskListener,
    resetSandbox,
  }
}
