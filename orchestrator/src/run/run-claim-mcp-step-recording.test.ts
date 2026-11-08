import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import type { Agent } from '../agent/agents.ts'
import { db } from '../database/db.ts'
import { probeConnection } from './run-claim-mcp.ts'

function probeInput(runId: string, cwd: string, runsDir: string) {
  db()
    .query("UPDATE run SET cwd=?,worktree=?,worktree_source='git' WHERE record_id=?")
    .run(cwd, cwd, runId)
  return {
    plan: [],
    callerCwd: cwd,
    agent: { name: 'grok', harness: 'grok' } as Agent,
    agentName: 'grok',
    runtimeDir: join(runsDir, 'runtime'),
    runtimeDirExisted: false,
    sandboxRootId: runId,
    runId,
    runProjectId: null,
    runsDir,
    cwd,
    inherited: false,
    writesJob: false,
    repoJob: true,
    mcpMode: null,
    mcpConnection: null,
    usingMcp: true,
  }
}

test('probeConnection records pending trust by cwd before granting its verbatim heading', () => {
  const runId = addRun({ agent: 'grok', job: 'understand', status: 'running' })
  const root = mkdtempSync(join(tmpdir(), 'orch-trust-step-'))
  const cwd = join(root, 'tree')
  const grokHome = join(root, 'grok')
  const heading = `[folders.${JSON.stringify(cwd)}]`
  mkdirSync(cwd)
  mkdirSync(grokHome)
  try {
    const result = probeConnection(
      probeInput(runId, cwd, root),
      'fixture',
      { GROK_HOME: grokHome },
      (_name, observedCwd, server) => {
        expect(observedCwd).toBe(cwd)
        expect(
          db()
            .query(
              `SELECT state,allocation_key FROM resource_claim
               WHERE root_run_record_id=? AND kind='trust_entry'`,
            )
            .get(runId),
        ).toEqual({ state: 'pending', allocation_key: cwd })
        writeFileSync(join(grokHome, 'trusted_folders.toml'), `${heading}\ntrusted = true\n`)
        return { server, connected: true, error: null }
      },
    )
    expect(result.trustGranted).toBe(true)
    expect(
      db()
        .query(
          `SELECT state,allocation_key,step_no FROM resource_claim
           WHERE root_run_record_id=? AND kind='trust_entry'`,
        )
        .get(runId),
    ).toEqual({ state: 'claimed', allocation_key: heading, step_no: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probeConnection leaves every unexpectedly added trust heading on a stuck row', () => {
  const runId = addRun({ agent: 'grok', job: 'understand', status: 'running' })
  const root = mkdtempSync(join(tmpdir(), 'orch-trust-stuck-'))
  const cwd = join(root, 'tree')
  const grokHome = join(root, 'grok')
  const headings = [`[folders.${JSON.stringify(cwd)}]`, '[folders."unexpected"]']
  mkdirSync(cwd)
  mkdirSync(grokHome)
  try {
    expect(() =>
      probeConnection(probeInput(runId, cwd, root), 'fixture', { GROK_HOME: grokHome }, () => {
        writeFileSync(join(grokHome, 'trusted_folders.toml'), `${headings.join('\n')}\n`)
        return { server: 'fixture', connected: true, error: null }
      }),
    ).toThrow('created 2 entries; expected one')
    const row = db()
      .query(
        `SELECT state,settled_detail FROM resource_claim
         WHERE root_run_record_id=? AND kind='trust_entry'`,
      )
      .get(runId) as { state: string; settled_detail: string }
    expect(row.state).toBe('stuck')
    expect(row.settled_detail).toContain(JSON.stringify(headings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probeConnection marks pending trust stuck when no heading is observed', () => {
  const runId = addRun({ agent: 'grok', job: 'understand', status: 'running' })
  const root = mkdtempSync(join(tmpdir(), 'orch-trust-missing-'))
  const cwd = join(root, 'tree')
  const grokHome = join(root, 'grok')
  mkdirSync(cwd)
  mkdirSync(grokHome)
  try {
    probeConnection(probeInput(runId, cwd, root), 'fixture', { GROK_HOME: grokHome }, () => ({
      server: 'fixture',
      connected: true,
      error: null,
    }))
    expect(
      db()
        .query(
          `SELECT state,settled_detail FROM resource_claim
           WHERE root_run_record_id=? AND kind='trust_entry'`,
        )
        .get(runId),
    ).toEqual({ state: 'stuck', settled_detail: 'no trust heading observed' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
