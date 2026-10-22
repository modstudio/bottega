// concern: host-side ask endpoint preparation for sandboxed ACP writers

import { type AskLoopback, startAskHttpEndpoint } from '../ask/ask.ts'
import { worktreeGitDir } from '../git/git-environment.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { provisionWriterSharedGitRoots } from './run-git-guard.ts'

const WRITING_ACP_GIT_INSTRUCTION =
  'The orchestrator checkpoints and commits this run from the host. Do not run git commands that write.'

export function bindContract(prompt: string, writingAcp: boolean): string {
  return writingAcp ? `${prompt}\n\n${WRITING_ACP_GIT_INSTRUCTION}` : prompt
}

export function writableRoots(
  worktree: Worktree | null,
  writesRepo: boolean,
  writingAcp: boolean,
  scratchDir: string,
): string[] {
  return [scratchDir, ...provisionWriterSharedGitRoots(worktree, writesRepo && !writingAcp)]
}

export function checkpointGitDir(worktree: Worktree | null, writingAcp: boolean): string | null {
  return writingAcp && worktree ? worktreeGitDir(worktree.path) : null
}

export function lifecycleFacts(
  writingAcp: boolean,
  checkpointGitDir: string | null,
  brokerNeedsNetwork: boolean,
) {
  return { writingAcp, checkpointGitDir, brokerNeedsNetwork }
}

export function prepareWritingAcpAsk(
  writingAcp: boolean,
  runId: string,
  token: string,
): {
  loopback: AskLoopback | null
  sandbox: { askAddress?: string }
} {
  if (!writingAcp) return { loopback: null, sandbox: {} }
  const loopback = startAskHttpEndpoint(runId, token)
  return {
    loopback,
    sandbox: { askAddress: new URL(loopback.url).host },
  }
}
