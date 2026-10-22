// concern: writing-ACP git contract, writable roots, checkpoint containment, and host ask endpoint

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type AskLoopback, startAskHttpEndpoint } from '../ask/ask.ts'
import { worktreeGitDir } from '../git/git-environment.ts'
import { codexWritableRoots } from '../sandbox/codex-sandbox.ts'
import { writingAcpWritableRoots } from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { CheckpointContainment } from './checkpoint.ts'
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
  if (writingAcp) {
    if (!worktree) throw new Error('writing ACP confinement requires a run worktree')
    return writingAcpWritableRoots(worktree.path, scratchDir)
  }
  return [scratchDir, ...provisionWriterSharedGitRoots(worktree, writesRepo && !writingAcp)]
}

export function confinementRoots(
  srtProfile: { filesystem: { allowWrite: string[] } } | null,
  agent: string,
  cwd: string,
  extraRoots: string[],
  tmpDir: string | undefined,
): string[] | null {
  if (srtProfile) return srtProfile.filesystem.allowWrite
  return agent === 'codex' ? codexWritableRoots(cwd, extraRoots, tmpDir) : null
}

/** Pure per-run facts used by every host checkpoint path. */
export function checkpointContainment(
  gitDir: string | null,
  writingAcp: boolean,
  runDir: string,
): CheckpointContainment {
  return writingAcp && gitDir
    ? {
        gitDir,
        hooksDir: join(runDir, 'checkpoint-hooks'),
        disableHooks: true,
      }
    : { gitDir: null, hooksDir: null, disableHooks: false }
}

/** Create the empty orchestrator-owned hook directory before any host git operation. */
function prepareCheckpointContainment(facts: CheckpointContainment): CheckpointContainment {
  if (facts.disableHooks) mkdirSync(facts.hooksDir!, { recursive: true })
  return facts
}

export function prepareCheckpoint(
  worktree: Worktree | null,
  writingAcp: boolean,
  runDir: string,
): CheckpointContainment {
  const gitDir = writingAcp && worktree ? worktreeGitDir(worktree.path) : null
  return prepareCheckpointContainment(checkpointContainment(gitDir, writingAcp, runDir))
}

export function lifecycleFacts(
  writingAcp: boolean,
  checkpointContainment: CheckpointContainment,
  _legacyBrokerNeedsNetwork: boolean,
) {
  return { writingAcp, checkpointContainment }
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

/** The startup scope owns the listener until control transfers to runLive. */
export async function disposeAskAfterStartup(
  loopback: AskLoopback | null,
  startupComplete: boolean,
): Promise<void> {
  if (!startupComplete) await loopback?.close()
}
