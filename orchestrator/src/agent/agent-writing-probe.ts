// concern: ACP registration writing probe
/** Owns the disposable writing check. Must not know registry persistence or CLI grammar. */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import type { Project } from '../project/projects.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv, writerProfile } from '../sandbox/sandbox.ts'
import type { Agent } from './agents.ts'

const WRITING_PROBE_FILE = 'registration-probe-write.txt'
const WRITING_PROBE_CONTENT = 'REGISTRATION_PROBE_WRITE_OK\n'

export type WritingProbeResult = { ok: boolean | null; output: string }

type WritingProbeLaunch = {
  cwd: string
  prompt: string
  profile: SandboxRuntimeConfig
  launch: typeof sandboxLaunchArgv
}
export type WritingProbeConfinement = Omit<WritingProbeLaunch, 'prompt'>

type WritingProbeAgentCall = (
  input: WritingProbeLaunch,
) => Promise<{ status: 'ok' | 'failed' | 'asking'; output: string }>

type WritingProbePorts = {
  createWorktree(path: string): void
  removeWorktree(path: string): void
  callAgent: WritingProbeAgentCall
  launch: typeof sandboxLaunchArgv
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
      `registration writing probe could not create its git worktree: ${initialized.stderr.toString().trim() || `git init exited ${initialized.exitCode ?? 'unknown'}`}`,
    )
  }
}

const defaultWorktreePorts = {
  createWorktree: createScratchGitWorktree,
  removeWorktree: (path: string) => rmSync(path, { recursive: true, force: true }),
}

function shouldProbeWrites(transport: 'cli' | 'acp'): boolean {
  return transport === 'acp'
}

/** Run one ACP writer inside the same profile and transport launch used by a writing run. */
export async function probeAgentWrites(
  input: {
    transport: 'cli' | 'acp'
    scratch: string
    project: Project | null
    agent: Agent
    path?: string
  },
  ports: WritingProbePorts,
): Promise<WritingProbeResult> {
  if (!shouldProbeWrites(input.transport)) {
    return { ok: null, output: 'skipped: CLI transport never receives the writing check' }
  }
  if (!input.project) throw new Error('registration writing probe requires a registered project')
  const worktree = join(input.scratch, 'writing-worktree')
  const target = join(worktree, WRITING_PROBE_FILE)
  ports.createWorktree(worktree)
  try {
    const profile = writerProfile({
      worktree,
      runsDir: input.scratch,
      scratchDir: input.scratch,
      // The check exercises filesystem confinement, not the ask endpoint. The
      // writer profile still receives one exact loopback address as real runs do.
      askAddress: '127.0.0.1:1',
      project: input.project,
      agent: input.agent.name,
      path: input.path,
      baseUrl: input.agent.baseUrl,
    })
    const outcome = await ports.callAgent({
      cwd: worktree,
      prompt: `Create ${WRITING_PROBE_FILE} with exactly this content, including the final newline:\n${WRITING_PROBE_CONTENT}`,
      profile,
      launch: ports.launch,
    })
    const content = existsSync(target) ? readFileSync(target, 'utf8') : ''
    return {
      ok: outcome.status === 'ok' && content === WRITING_PROBE_CONTENT,
      output: outcome.output,
    }
  } finally {
    ports.removeWorktree(worktree)
  }
}

export function writingProbePorts(callAgent: WritingProbeAgentCall): WritingProbePorts {
  return { ...defaultWorktreePorts, callAgent, launch: sandboxLaunchArgv }
}
