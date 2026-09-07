import { describe, expect, test } from 'bun:test'
import {
  ACP_PILOT_TASK, assertAcpAllowed, failureKindFromStop, isAcpPilotJob,
  outcomeFromTransport, resolveTransportName,
} from './transport.ts'
import { acpOutcome, normalizeAcpTurn } from './transport-acp.ts'
import {
  ACP_FIXTURE_ELICITATION, ACP_FIXTURE_MALFORMED, ACP_FIXTURE_REFUSAL,
  ACP_FIXTURE_SCHEMA, ACP_FIXTURE_STRUCTURED_OK, ACP_FIXTURE_TIMEOUT,
  ACP_FIXTURE_TOOL_READ, ACP_FIXTURE_TRUNCATED,
} from './transport-acp.fixtures.ts'

describe('ACP transport selection', () => {
  test('defaults to cli, honours the flag and ORCH_TRANSPORT', () => {
    expect(resolveTransportName(undefined, undefined)).toBe('cli')
    expect(resolveTransportName(undefined, '')).toBe('cli')
    expect(resolveTransportName('cli', 'acp')).toBe('cli')
    expect(resolveTransportName(undefined, 'acp')).toBe('acp')
    expect(resolveTransportName('acp')).toBe('acp')
    expect(() => resolveTransportName('grpc')).toThrow('unknown transport')
  })

  test('the pilot allow-list is the four read-only jobs', () => {
    expect(isAcpPilotJob('understand')).toBe(true)
    expect(isAcpPilotJob('file-question')).toBe(true)
    expect(isAcpPilotJob('verify-claim')).toBe(true)
    expect(isAcpPilotJob('summarize')).toBe(true)
    expect(isAcpPilotJob('implement')).toBe(false)
    expect(isAcpPilotJob('diagnose')).toBe(false)
  })

  test('writing jobs refuse naming the pilot task', () => {
    expect(() => assertAcpAllowed('implement', 'codex')).toThrow(ACP_PILOT_TASK)
    expect(() => assertAcpAllowed('implement', 'codex')).toThrow('writing jobs')
    expect(() => assertAcpAllowed('fix', undefined)).toThrow('writing jobs')
  })

  test('non-codex and jobs outside the allow-list are refused', () => {
    expect(() => assertAcpAllowed('understand', 'grok')).toThrow('only available for codex')
    expect(() => assertAcpAllowed('review-lens', 'codex')).toThrow('allowed jobs')
    expect(() => assertAcpAllowed('understand', 'codex')).not.toThrow()
    expect(() => assertAcpAllowed('understand', undefined)).not.toThrow()
  })
})

describe('ACP event fixtures normalise to orch outcomes', () => {
  test('a structured reply is ok with text and tokens', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_STRUCTURED_OK)
    expect(acpOutcome(result)).toBe('ok')
    expect(outcomeFromTransport(result)).toEqual({ status: 'ok', failureKind: null })
    expect(result.output).toBe('{"status":"ok"}')
    expect(result.tokens).toBe(1200)
    expect(result.sessionId).toBe('sess_parity_ok')
    expect(result.events.some((event) => event.kind === 'text')).toBe(true)
    expect(result.events.some((event) => event.kind === 'usage')).toBe(true)
    expect(result.events.some((event) => event.kind === 'stop' && event.reason === 'end_turn')).toBe(true)
  })

  test('a tool-using read records the tool and the answer', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_TOOL_READ)
    expect(acpOutcome(result)).toBe('ok')
    expect(result.output).toBe('"@devbox/orchestrator"')
    expect(result.events.some((event) => event.kind === 'tool' && event.toolKind === 'read')).toBe(true)
  })

  test('a schema-shaped reply is ok with the JSON body', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_SCHEMA)
    expect(acpOutcome(result)).toBe('ok')
    expect(result.output).toBe('{"verdict":"true"}')
  })

  test('a forced timeout is failed with timeout', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_TIMEOUT)
    expect(acpOutcome(result)).toBe('failed')
    expect(result.stopReason).toBe('timeout')
    expect(failureKindFromStop(result.stopReason, result.error)).toBe('timeout')
    expect(result.output).toBe('')
  })

  test('a malformed reply still surfaces the raw text as ok at this layer', () => {
    // Completeness of JSON is a later contract check. The transport's job is
    // to hand the bytes through; a single '{' is a successful turn with odd text.
    const result = normalizeAcpTurn(ACP_FIXTURE_MALFORMED)
    expect(acpOutcome(result)).toBe('ok')
    expect(result.output).toBe('{')
  })

  test('elicitation maps to asking', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_ELICITATION)
    expect(acpOutcome(result)).toBe('asking')
    expect(outcomeFromTransport(result).status).toBe('asking')
    expect(result.questions[0]?.question).toContain('two designs')
  })

  test('max_tokens and refusal map to orch failure kinds', () => {
    const truncated = normalizeAcpTurn(ACP_FIXTURE_TRUNCATED)
    expect(acpOutcome(truncated)).toBe('failed')
    expect(failureKindFromStop(truncated.stopReason, truncated.error)).toBe('truncated')
    const refused = normalizeAcpTurn(ACP_FIXTURE_REFUSAL)
    expect(acpOutcome(refused)).toBe('failed')
    expect(failureKindFromStop(refused.stopReason, refused.error)).toBe('content_refusal')
  })
})
