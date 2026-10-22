// concern: host-side ask endpoint preparation for sandboxed ACP writers

import { type AskLoopback, startAskHttpEndpoint } from '../ask/ask.ts'
import type { TransportName } from '../transport/transport.ts'

export function prepareWritingAcpAsk(
  transport: TransportName,
  writesRepo: boolean,
  runId: string,
  token: string,
): {
  loopback: AskLoopback | null
  sandbox: { writingAcp: boolean; askAddress?: string }
} {
  const writingAcp = transport === 'acp' && writesRepo
  if (!writingAcp) return { loopback: null, sandbox: { writingAcp } }
  const loopback = startAskHttpEndpoint(runId, token)
  return {
    loopback,
    sandbox: { writingAcp, askAddress: new URL(loopback.url).host },
  }
}
