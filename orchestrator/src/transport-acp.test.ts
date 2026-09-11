import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS } from './agents.ts'
import {
  ACP_PILOT_TASK, acpRuntimeGaps, assertAcpAllowed, confineFsPath, decideAcpPermission,
  failureKindFromStop, isAcpPilotJob, outcomeFromTransport, resolveTransportName,
  selectAgentForTransport, stopErrorMessage, valueMatchesStrictSchema,
} from './transport.ts'
import {
  acpHarnessArgv, acpLeaderSocketPath, acpOutcome, acpSandboxProfile, grokEffectiveModel,
  grokSessionMeta, normalizeAcpTurn,
} from './transport-acp.ts'
import {
  ACP_FIXTURE_CANCELLED_TEXT, ACP_FIXTURE_EDIT_PERMISSION, ACP_FIXTURE_ELICITATION,
  ACP_FIXTURE_GROK, ACP_FIXTURE_MALFORMED, ACP_FIXTURE_REFUSAL, ACP_FIXTURE_SCHEMA,
  ACP_FIXTURE_STRUCTURED_OK, ACP_FIXTURE_TIMEOUT, ACP_FIXTURE_TOOL_READ,
  ACP_FIXTURE_TRUNCATED, ACP_FIXTURE_TRUNCATED_TEXT,
} from './transport-acp.fixtures.ts'

describe('ACP transport selection', () => {
  test('model-agnostic harnesses expose their ACP stdio command', () => {
    expect(acpHarnessArgv('opencode')).toEqual(['acp'])
    expect(acpHarnessArgv('goose')).toEqual(['acp'])
    expect(acpHarnessArgv('codex')).toEqual([])
  })
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

  test('paid ACP agents are allowed and jobs outside the allow-list are refused', () => {
    expect(() => assertAcpAllowed('understand', 'grok')).not.toThrow()
    expect(() => assertAcpAllowed('review-lens', 'codex')).toThrow('allowed jobs')
    expect(() => assertAcpAllowed('understand', 'codex')).not.toThrow()
    expect(() => assertAcpAllowed('understand', undefined)).not.toThrow()
  })

  test('installed paid-agent capability rows record native elicitation as unsupported', () => {
    for (const name of ['codex', 'grok']) {
      const agent = AGENTS[name]!
      expect(agent.defaultTransport).toBe('cli')
      expect(agent.acp?.nativeElicitation).toBe(false)
      expect(agent.acp?.nativeElicitationReason).toMatch(/emitted no elicitation\/create|unavailable/)
    }
    expect(AGENTS.codex!.acp?.mcpServers).toBe(true)
    expect(AGENTS.grok!.acp?.mcpServers).toBe(false)
    expect(AGENTS.grok!.acp?.mcpReason).toContain('GROK_HOME fallback delivered')
  })

  test('grok model is passed through session/new and read back from the session', () => {
    expect(grokSessionMeta('grok-4.5')).toEqual({ modelId: 'grok-4.5' })
    expect(grokEffectiveModel({
      models: { currentModelId: 'grok-4.5', availableModels: [] },
    }, 'grok-4.5', true)).toBe('grok-4.5')
  })

  test('an explicit grok model the ACP session did not honour is refused with its anchor', () => {
    expect(() => grokEffectiveModel({
      models: { currentModelId: 'grok-4.6', availableModels: [] },
    }, 'grok-4.5', true)).toThrow(`${ACP_PILOT_TASK} Grok ACP model refusal`)
    expect(() => grokEffectiveModel({}, 'grok-4.5', true)).toThrow('no effective model')
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

  test('PromptResponse.usage without token fields stays unreported rather than 0', () => {
    const result = normalizeAcpTurn({
      sessionId: 'sess_no_usage',
      updates: [{
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      }],
      stopReason: 'end_turn',
      usage: {},
    })
    expect(result.tokens).toBeNull()
    expect(result.costUsd).toBeNull()
    expect(result.events.some((event) => event.kind === 'usage')).toBe(false)
  })

  test('PromptResponse.usage records vendor tokens and cost when emitted', () => {
    const result = normalizeAcpTurn({
      sessionId: 'sess_usage',
      updates: [{
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
    })
    expect(result.tokens).toBe(15)
    expect(result.costUsd).toBe(0.002)
  })

  test('a tool-using read records the tool and the answer', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_TOOL_READ)
    expect(acpOutcome(result)).toBe('ok')
    expect(result.output).toBe('"@devbox/orchestrator"')
    expect(result.events.some((event) => event.kind === 'tool' && event.toolKind === 'read')).toBe(true)
  })

  test('a completed read captures the target path and tool result', () => {
    const result = normalizeAcpTurn({
      sessionId: 'sess_probe',
      updates: [{
        sessionUpdate: 'tool_call',
        title: 'Read probe.txt',
        kind: 'read',
        status: 'completed',
        locations: [{ path: '/tmp/repo/probe.txt' }],
        content: [{ type: 'content', content: { type: 'text', text: 'REGISTRATION_PROBE_FILE_OK\n' } }],
      }],
      stopReason: 'end_turn',
    })
    expect(result.events.some((event) => event.kind === 'tool' &&
      event.toolKind === 'read' && event.status === 'completed' &&
      event.target === '/tmp/repo/probe.txt' &&
      event.result === 'REGISTRATION_PROBE_FILE_OK\n')).toBe(true)
  })

  test('grok updates use terminal input plus output usage, not session-context used', () => {
    const result = normalizeAcpTurn(ACP_FIXTURE_GROK)
    expect(result.output).toBe('@devbox/orchestrator')
    expect(result.tokens).toBe(101_505)
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
    expect(truncated.error).toBe(stopErrorMessage('max_tokens'))
    const refused = normalizeAcpTurn(ACP_FIXTURE_REFUSAL)
    expect(acpOutcome(refused)).toBe('failed')
    expect(failureKindFromStop(refused.stopReason, refused.error)).toBe('content_refusal')
    expect(refused.error).toBe(stopErrorMessage('refusal'))
  })

  test('partial text does not rescue a non-end_turn stop', () => {
    const truncated = normalizeAcpTurn(ACP_FIXTURE_TRUNCATED_TEXT)
    expect(acpOutcome(truncated)).toBe('failed')
    expect(truncated.failureKind).toBe('truncated')
    expect(truncated.output).toBe('partial answer')
    expect(truncated.exitCode).not.toBe(0)
    const cancelled = normalizeAcpTurn(ACP_FIXTURE_CANCELLED_TEXT)
    expect(acpOutcome(cancelled)).toBe('failed')
    expect(cancelled.failureKind).toBe('interrupted')
    expect(cancelled.output).toBe('partial before cancel')
    expect(cancelled.exitCode).not.toBe(0)
  })
})

describe('ACP defaults Codex and preflight names the missing piece', () => {
  test('ACP without an agent name pins Codex', () => {
    expect(selectAgentForTransport('acp', undefined)).toBe('codex')
    expect(selectAgentForTransport('acp', 'codex')).toBe('codex')
    expect(selectAgentForTransport('cli', undefined)).toBeUndefined()
    expect(selectAgentForTransport('cli', 'grok')).toBe('grok')
  })

  test('preflight names a missing SDK', () => {
    const gap = acpRuntimeGaps({
      sdkResolve: () => { throw new Error('Cannot find module') },
      binExists: () => true,
    })
    expect(gap).toContain(ACP_PILOT_TASK)
    expect(gap).toContain('@agentclientprotocol/sdk')
  })

  test('preflight names a missing codex-acp binary', () => {
    const gap = acpRuntimeGaps({
      sdkResolve: () => '/fake/sdk',
      binPath: '/no/such/codex-acp',
      binExists: () => false,
    })
    expect(gap).toContain(ACP_PILOT_TASK)
    expect(gap).toContain('codex-acp')
  })

  test('preflight names a missing ajv', () => {
    const gap = acpRuntimeGaps({
      sdkResolve: () => '/fake/sdk',
      ajvResolve: () => { throw new Error('Cannot find module') },
      binExists: () => true,
    })
    expect(gap).toContain(ACP_PILOT_TASK)
    expect(gap).toContain('ajv')
  })
})

describe('ACP client-served fs is confined to the worktree', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test('the grok leader socket is the only socket added to the srt profile', () => {
    const profile = {
      network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: true },
      filesystem: { denyRead: [], allowWithinDeny: ['/tree'], allowWrite: ['/run'], denyWrite: [] },
    }
    const confined = acpSandboxProfile(profile, '/run/grok.leader.sock')
    expect(confined.network.allowUnixSockets).toEqual(['/run/grok.leader.sock'])
    expect(confined.filesystem).toEqual(profile.filesystem)
    expect(acpLeaderSocketPath('/evidence/out.txt', '/run/settings.json'))
      .toBe('/run/grok-leader.sock')
    expect(acpLeaderSocketPath('/evidence/out.txt')).toBe('/evidence/out.txt.leader.sock')
  })
  test('a path inside the worktree is allowed; a path outside is refused by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-acp-fs-'))
    roots.push(root)
    const inside = join(root, 'notes.txt')
    writeFileSync(inside, 'ok')
    expect(confineFsPath(inside, root)).toBe(realpathSync(inside))
    expect(confineFsPath('notes.txt', root)).toBe(realpathSync(inside))
    expect(() => confineFsPath('/etc/passwd', root)).toThrow('ACP fs.readTextFile refused')
    expect(() => confineFsPath('/etc/passwd', root)).toThrow('outside the run worktree')
  })

  test('a missing path is still confined by its resolved parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-acp-fs-missing-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    expect(confineFsPath(join(root, 'src', 'nope.ts'), root))
      .toBe(join(realpathSync(join(root, 'src')), 'nope.ts'))
    expect(() => confineFsPath(join(tmpdir(), 'outside-nope.ts'), root))
      .toThrow('ACP fs.readTextFile refused')
  })
})

describe('ACP permission policy', () => {
  test('a read-class tool is allowed once; an edit is rejected and recorded', () => {
    const allow = decideAcpPermission('read', ACP_FIXTURE_EDIT_PERMISSION.options)
    expect(allow.decision).toBe('allow')
    const edit = decideAcpPermission(
      ACP_FIXTURE_EDIT_PERMISSION.toolKind, ACP_FIXTURE_EDIT_PERMISSION.options,
    )
    expect(edit.decision).toBe('reject')
    expect(edit.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    const result = normalizeAcpTurn({
      sessionId: 'sess_edit',
      updates: [{
        sessionId: 'sess_edit',
        update: {
          sessionUpdate: 'tool_call',
          title: ACP_FIXTURE_EDIT_PERMISSION.title,
          kind: 'edit',
          status: 'failed',
        },
      }],
      permissionEvents: [{
        kind: 'permission',
        title: ACP_FIXTURE_EDIT_PERMISSION.title,
        optionKinds: ACP_FIXTURE_EDIT_PERMISSION.options.map((option) => option.kind),
        toolKind: 'edit',
        decision: edit.decision,
      }],
      stopReason: 'end_turn',
    })
    expect(result.events.some((event) =>
      event.kind === 'permission' && event.decision === 'reject' && event.toolKind === 'edit',
    )).toBe(true)
  })

  test('execute and write-class tools are rejected', () => {
    const options = ACP_FIXTURE_EDIT_PERMISSION.options
    expect(decideAcpPermission('execute', options).decision).toBe('reject')
    expect(decideAcpPermission('delete', options).decision).toBe('reject')
    expect(decideAcpPermission('move', options).decision).toBe('reject')
  })
})

describe('strict schema matching used on the ACP path', () => {
  test('a malformed object fails the same strict subset Codex --output-schema uses', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'string' } },
    }
    expect(valueMatchesStrictSchema(schema, { verdict: 'true' })).toBe(true)
    expect(valueMatchesStrictSchema(schema, { verdict: 'true', extra: 1 })).toBe(false)
    expect(valueMatchesStrictSchema(schema, '{')).toBe(false)
  })
})

describe('tool_call_update folds into its tool_call', () => {
  test('a goose-shaped read (call with target, update with only the status) satisfies the readsRepo probe gate', async () => {
    const { registrationProbeReadsRepo } = await import('./agents.ts')
    const result = normalizeAcpTurn({
      sessionId: 's', stopReason: 'end_turn', updates: [
        { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read probe.txt', kind: 'read', status: 'pending', locations: [{ path: '/tmp/probe/probe.txt' }] } },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' } },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'REGISTRATION_PROBE_FILE_OK' } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The contents are REGISTRATION_PROBE_FILE_OK' } } },
      ],
    })
    const tools = result.events.filter((event) => event.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ status: 'completed', toolKind: 'read', target: '/tmp/probe/probe.txt', result: 'REGISTRATION_PROBE_FILE_OK' })
    expect(registrationProbeReadsRepo(result.events, result.output)).toBe(true)
  })

  test('an update naming no known call stays its own event, and an unrelated tool plus a hallucinated sentinel still fails the gate', async () => {
    const { registrationProbeReadsRepo } = await import('./agents.ts')
    const result = normalizeAcpTurn({
      sessionId: 's', stopReason: 'end_turn', updates: [
        { update: { sessionUpdate: 'tool_call', toolCallId: 'call-9', title: 'list directory', kind: 'execute', status: 'completed' } },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed' } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REGISTRATION_PROBE_FILE_OK' } } },
      ],
    })
    expect(result.events.filter((event) => event.kind === 'tool')).toHaveLength(2)
    expect(registrationProbeReadsRepo(result.events, result.output)).toBe(false)
  })
})
