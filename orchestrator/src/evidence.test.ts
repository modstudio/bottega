import { describe, expect, test } from 'bun:test'
import { assessEvidence, assessEvidencePrompt, type EvidenceFacts } from './evidence.ts'

const reviewReply = {
  findings: [],
  provenance: {
    standards_read: [], model_used: 'fixture', files_covered: ['src/a.ts'],
    commands_run: [], mcp_tools: [], docs_read: [], could_not_verify: [], substitutes: [], canon_source: 'mirror',
  },
} as EvidenceFacts['reviewReply']

const base: EvidenceFacts = {
  findingsJob: false,
  outputPresent: true,
  reviewReply: null,
  confinementClassification: null,
  cleanReview: null,
  otherProjectMcpServers: new Set(),
  ownMcpServer: 'fixture',
  readerJob: false,
  declaredDeliverables: [],
  readerReply: null,
}

describe('evidence prompt assessment', () => {
  test.each([
    ['reader deliverables', { readerJob: true, declaredDeliverables: ['table'] }, true, false],
    ['findings canon source', { findingsJob: true }, false, true],
    ['verify-claim canon source', { verifyClaimJob: true }, false, true],
  ] as const)('%s', (_name, facts, bindsReader, requiresCanon) => {
    const assessment = assessEvidencePrompt({
      findingsJob: false, verifyClaimJob: false, readerJob: false, declaredDeliverables: [], ...facts,
    })
    expect(Boolean(assessment.readerInstruction)).toBe(bindsReader)
    expect(assessment.requiresCanonSource).toBe(requiresCanon)
  })
})

describe('terminal evidence assessment', () => {
  test('provenance rejects only another registered project MCP prefix', () => {
    const assess = (tools: string[]) => assessEvidence(
      { status: 'ok', error: null, failureKind: null },
      { ...base, reviewReply: { ...reviewReply!, provenance: {
        ...reviewReply!.provenance, mcp_tools: tools,
      } }, otherProjectMcpServers: new Set(['other-server']), ownMcpServer: 'fixture-project' },
    )
    for (const tool of ['get_doc', 'mcp__fixture-project__get_doc', 'orch-ask.get_doc']) {
      expect(assess([tool]).status).toBe('ok')
    }
    expect(assess(['other-server.get_doc'])).toMatchObject({
      status: 'failed', failureKind: 'contract',
      error: 'wrong project: provenance names other-server.get_doc, expected fixture-project',
    })
  })

  test.each([
    ['findings admissibility', {
      findingsJob: true,
    }, { failureKind: 'contract', error: 'mandatory PROVENANCE' }],
    ['clean-review evidence', {
      findingsJob: true, reviewReply,
      cleanReview: { failure: 'clean review with no evidence', note: null, kind: 'unevidenced' },
    }, { failureKind: 'unevidenced', error: 'clean review with no evidence' }],
    ['wrong-project provenance', {
      reviewReply: {
        ...reviewReply!, provenance: { ...reviewReply!.provenance, mcp_tools: ['mcp__other__read'] },
      },
      otherProjectMcpServers: new Set(['other']),
    }, { failureKind: 'contract', error: 'wrong project' }],
    ['dotted wrong-project provenance', {
      reviewReply: {
        ...reviewReply!, provenance: { ...reviewReply!.provenance, mcp_tools: ['other.read'] },
      },
      otherProjectMcpServers: new Set(['other']),
    }, { failureKind: 'contract', error: 'wrong project' }],
    ['run 3382 Codex Apps provenance', {
      reviewReply: {
        ...reviewReply!, provenance: {
          ...reviewReply!.provenance,
          mcp_tools: [
            'codex_apps.alephbeis_mcp_get_workflow_step_tool',
            'codex_apps.alephbeis_mcp_get_rule_tool',
            'starship.get_task_tool',
            'starship.list_task_documents_tool',
          ],
        },
      },
      otherProjectMcpServers: new Set(['alephbeis', 'stopal']),
      ownMcpServer: 'starship',
    }, {
      failureKind: 'contract',
      error: 'wrong project: provenance names codex_apps.alephbeis_mcp_get_workflow_step_tool, expected starship',
    }],
    ['run 3385 Codex Apps provenance', {
      reviewReply: {
        ...reviewReply!, provenance: {
          ...reviewReply!.provenance,
          mcp_tools: [
            'codex_apps.alephbeis_mcp_get_workflow_step_tool',
            'codex_apps.alephbeis_mcp_get_rule_tool',
          ],
        },
      },
      otherProjectMcpServers: new Set(['alephbeis', 'stopal']),
      ownMcpServer: 'starship',
    }, {
      failureKind: 'contract',
      error: 'wrong project: provenance names codex_apps.alephbeis_mcp_get_workflow_step_tool, expected starship',
    }],
    ['reader deliverable completeness', {
      readerJob: true, declaredDeliverables: ['table'], readerReply: { deliverables: [], narrative: null, files_written: null },
    }, { failureKind: 'unevidenced', error: 'missing declared deliverable' }],
  ] as const)('%s', (_name, facts, expected) => {
    const assessment = assessEvidence(
      { status: 'ok', error: null, failureKind: null },
      { ...base, ...facts } as EvidenceFacts,
    )
    expect(assessment.status).toBe('failed')
    expect(assessment.failureKind).toBe(expected.failureKind)
    expect(assessment.error).toContain(expected.error)
  })

  test.each([
    ['own server through Codex Apps', 'codex_apps.starship_mcp_get_task_tool'],
    ['unregistered server through Codex Apps', 'codex_apps.github_mcp_search'],
  ])('%s stays ok', (_name, tool) => {
    const assessment = assessEvidence(
      { status: 'ok', error: null, failureKind: null },
      {
        ...base,
        reviewReply: {
          ...reviewReply!, provenance: { ...reviewReply!.provenance, mcp_tools: [tool] },
        },
        otherProjectMcpServers: new Set(['alephbeis', 'stopal']),
        ownMcpServer: 'starship',
      },
    )
    expect(assessment.status).toBe('ok')
    expect(assessment.provenanceWrongProjectTool).toBeNull()
  })
})
