// concern: host-side ask endpoint preparation for sandboxed ACP writers

import { type AskLoopback, startAskHttpEndpoint } from '../ask/ask.ts'
export const WRITING_ACP_GIT_INSTRUCTION =
  'The orchestrator checkpoints and commits this run from the host. Do not run git commands that write.'

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
