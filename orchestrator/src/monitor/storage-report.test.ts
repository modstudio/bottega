import { afterEach, expect, test } from 'bun:test'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatStorageReport, measureRunStorage, measureStoragePaths } from './storage-report.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function allocatedBytes(path: string): number {
  const stat = lstatSync(path)
  return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size
}

test('the bounded adapter classifies files, deduplicates hard links, and labels partial totals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-report-'))
  roots.push(root)
  const run = join(root, '1')
  const artifacts = join(run, 'artifacts')
  const scratch = join(run, 'scratch')
  const sandbox = join(root, 'sandbox-1')
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(scratch)
  mkdirSync(sandbox)
  const artifact = join(artifacts, 'artifact.bin')
  const artifactLink = join(artifacts, 'artifact-link.bin')
  const scratchFile = join(scratch, 'scratch.bin')
  const prompt = join(run, 'turn.prompt.txt')
  const boundPrompt = join(run, 'turn.bound.txt')
  const reply = join(run, 'reply.txt')
  const sandboxFile = join(sandbox, 'sandbox.bin')
  writeFileSync(artifact, 'artifact'.repeat(1_024))
  linkSync(artifact, artifactLink)
  writeFileSync(scratchFile, 'scratch')
  writeFileSync(prompt, 'prompt')
  writeFileSync(boundPrompt, 'bound')
  writeFileSync(reply, 'reply')
  writeFileSync(sandboxFile, 'sandbox')
  mkdirSync(join(root, 'zz-overflow', 'a', 'b', 'c'), { recursive: true })

  expect(measureStoragePaths([artifacts])).toMatchObject({
    bytes: allocatedBytes(artifacts) + allocatedBytes(artifact),
    entries: 3,
    stoppedAtLimit: false,
  })

  const measured = await measureRunStorage(
    root,
    [
      {
        id: 1,
        status: 'running',
        started_at: '2026-10-18T11:00:00.000Z',
        prompt_path: prompt,
        output_path: reply,
      },
    ],
    Date.parse('2026-10-18T12:00:00.000Z'),
    14,
  )

  expect(measured.kinds.artifacts).toMatchObject({
    bytes: allocatedBytes(artifacts) + allocatedBytes(artifact),
    entries: 3,
    state: 'partial',
  })
  expect(measured.kinds.scratch).toMatchObject({
    bytes: allocatedBytes(scratch) + allocatedBytes(scratchFile),
    entries: 2,
    state: 'partial',
  })
  expect(measured.kinds.prompts).toMatchObject({
    bytes: allocatedBytes(prompt) + allocatedBytes(boundPrompt),
    entries: 2,
    state: 'partial',
  })
  expect(measured.kinds.replies).toMatchObject({ bytes: allocatedBytes(reply), entries: 1 })
  expect(measured.kinds.sandboxes).toMatchObject({
    bytes: allocatedBytes(sandbox) + allocatedBytes(sandboxFile),
    entries: 2,
  })
  expect(measured.largestRuns.artifacts).toMatchObject({
    state: 'partial',
    runs: [{ runId: 1, state: 'partial' }],
  })

  const text = formatStorageReport({
    measuredAt: '2026-10-18T12:00:00.000Z',
    walkDurationMs: 1,
    entryLimit: 14,
    runs: measured,
    worktrees: [],
    stores: [],
    volume: { path: root, freeBytes: 1, totalBytes: 2, error: null },
  })
  expect(text).toContain('largest artifacts (partial ranking):')
  expect(text).toContain('run 1: at least ')
  expect(JSON.stringify(measured.largestRuns.artifacts)).toContain('"state":"partial"')
})
