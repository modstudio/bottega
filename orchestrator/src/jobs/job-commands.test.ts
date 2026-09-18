import { describe, expect, test } from 'bun:test'
import { jobsCommand } from './job-commands.ts'

function output(json = false) {
  const lines: string[] = []
  jobsCommand(json, { log: (value) => lines.push(value) })
  return lines
}

describe('jobs command', () => {
  test('human listing distinguishes inline jobs from their truthy needs', () => {
    const lines = output()

    expect(lines.find((line) => line.startsWith('summarize'))).toBe(
      'summarize       Condense supplied text. Context is inline; no repo access needed. [inline] [axes delivery,quality]',
    )
    expect(lines.find((line) => line.startsWith('review-lens-inline'))).toBe(
      'review-lens-inline Review a fully self-contained pack. Everything needed is in the prompt; nothing is fetched. [inline] [axes delivery,quality]',
    )
    expect(lines.find((line) => line.startsWith('mcp-query'))).toBe(
      'mcp-query       Answer using this machine’s MCP servers (tracker, docs store, database). [needs mcp] [inline] [axes delivery,quality]',
    )
    expect(lines.find((line) => line.startsWith('implement'))).toBe(
      'implement       Implement a bounded spec in a throwaway worktree. Escalate every design decision; never guess. [needs readsRepo,writesRepo,resumable] [axes delivery,quality,fidelity]',
    )
  })

  test('json listing preserves false needs', () => {
    const jobs = JSON.parse(output(true)[0]!) as Array<{
      name: string
      needs: Record<string, boolean>
    }>

    expect(jobs.find((job) => job.name === 'summarize')?.needs).toEqual({ readsRepo: false })
    expect(jobs.find((job) => job.name === 'review-lens-inline')?.needs).toEqual({
      readsRepo: false,
    })
    expect(jobs.find((job) => job.name === 'mcp-query')?.needs).toEqual({
      readsRepo: false,
      mcp: true,
    })
  })
})
