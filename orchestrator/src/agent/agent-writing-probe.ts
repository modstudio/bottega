// concern: ACP registration writing probe
/** Owns the disposable writing check. Must not know registry persistence or CLI grammar. */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

const WRITING_PROBE_FILE = 'registration-probe-write.txt'
const WRITING_PROBE_CONTENT = 'REGISTRATION_PROBE_WRITE_OK\n'

export type WritingProbeResult = { ok: boolean | null; output: string }

type WritingProbeLaunch = {
  cwd: string
  prompt: string
  profile: SandboxRuntimeConfig
}
export type WritingProbeConfinement = Omit<WritingProbeLaunch, 'prompt'>

type WritingProbeAgentCall = (
  input: WritingProbeLaunch,
) => Promise<{ status: 'ok' | 'failed' | 'asking'; output: string }>

export type WritingProbePorts = {
  createWorktree(path: string): void
  removeWorktree(path: string): void
  callAgent: WritingProbeAgentCall
  openAskListener(): WritingProbeAskListener
  resetSandbox(): Promise<void>
}

type WritingProbeAskListener = { address: string; close(): void | Promise<void> }

function createScratchGitWorktree(path: string): void {
  mkdirSync(path, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', '--quiet', path], {
    env: scrubbedGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) {
    throw new Error(
      `registration writing probe could not create its git worktree: ${initialized.stderr.toString().trim() || `git init exited ${initialized.exitCode ?? 'unknown'}`}`,
    )
  }
}

const defaultWorktreePorts = {
  createWorktree: createScratchGitWorktree,
  removeWorktree: (path: string) => rmSync(path, { recursive: true, force: true }),
}

/** One owner for whether and how a transport establishes repository-writing capability. */
export function writingCapabilityPolicy(
  transport: 'cli' | 'acp',
  observation: boolean | null | undefined,
): { requiresObservation: boolean; writesRepo: boolean | null; jobSuccess: boolean } {
  const requiresObservation = transport === 'acp'
  return {
    requiresObservation,
    writesRepo: requiresObservation && observation != null ? observation : null,
    jobSuccess: !requiresObservation || observation === true,
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

function openProbeAskListener(): WritingProbeAskListener {
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

export type WritingProbeInput = {
  transport: 'cli' | 'acp'
  scratch: string
  agent: Agent
  path?: string
  environment: ConfigEnvironment
}

/** Share the writer's disposable worktree, ask listener, srt profile, and teardown. */
export async function withWritingProbeSandbox<T>(
  input: WritingProbeInput,
  ports: WritingProbePorts,
  operation: (confinement: WritingProbeConfinement) => Promise<T>,
): Promise<T> {
  const worktree = join(input.scratch, 'writing-worktree')
  let askListener: WritingProbeAskListener | null = null
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
    if (!selection.profile) throw new Error('registration writing probe did not select srt')
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

/** Run one ACP writer inside the same profile and transport launch used by a writing run. */
export async function probeAgentWrites(
  input: WritingProbeInput,
  ports: WritingProbePorts,
): Promise<WritingProbeResult> {
  if (!writingCapabilityPolicy(input.transport, null).requiresObservation) {
    return { ok: null, output: 'skipped: CLI transport never receives the writing check' }
  }
  try {
    return await withWritingProbeSandbox(input, ports, async ({ cwd, profile }) => {
      const target = join(cwd, WRITING_PROBE_FILE)
      const outcome = await ports.callAgent({
        cwd,
        prompt: `Create ${WRITING_PROBE_FILE} with exactly this content, including the final newline:\n${WRITING_PROBE_CONTENT}`,
        profile,
      })
      const content = existsSync(target) ? readFileSync(target, 'utf8') : ''
      return {
        ok: outcome.status === 'ok' && content === WRITING_PROBE_CONTENT,
        output: outcome.output,
      }
    })
  } catch (error) {
    return { ok: false, output: String((error as Error).message ?? error) }
  }
}

export function writingProbePorts(callAgent: WritingProbeAgentCall): WritingProbePorts {
  return {
    ...defaultWorktreePorts,
    callAgent,
    openAskListener: openProbeAskListener,
    resetSandbox,
  }
}
