// concern: host-side ask endpoint preparation for sandboxed ACP writers

import { type AskLoopback, startAskHttpEndpoint } from '../ask/ask.ts'
import type { TransportName } from '../transport/transport.ts'

export function prepareWritingAcpAsk(input: {
  transport: TransportName
  writesRepo: boolean
  runId: string
  token: string
}): { loopback: AskLoopback | null; writingAcp: boolean; address?: string } {
  const writingAcp = input.transport === 'acp' && input.writesRepo
  if (!writingAcp) return { loopback: null, writingAcp }
  const loopback = startAskHttpEndpoint(input.runId, input.token)
  return { loopback, writingAcp, address: new URL(loopback.url).host }
}
