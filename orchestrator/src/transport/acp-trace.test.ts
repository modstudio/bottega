import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createAcpTrace, installAcpStreamTrace, traceAcpHandshake } from './acp-trace.ts'

describe('ACP wire trace', () => {
  test('an absent trace installs no stream observers or write wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-acp-trace-off-'))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const write = stdin.write
    const dataListeners = stdout.listenerCount('data')

    try {
      const trace = createAcpTrace(undefined, '733', 4320, '/bin/agent', [], '/worktree', false)
      installAcpStreamTrace(trace, stdin, stdout)

      expect(trace).toBeNull()
      expect(readdirSync(root)).toEqual([])
      expect(stdin.write).toBe(write)
      expect(stdout.listenerCount('data')).toBe(dataListeners)
      expect(stdout.listenerCount('end')).toBe(0)
      expect(stdout.listenerCount('error')).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('records writes, reads, and every stage marker in observation order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-acp-trace-'))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    try {
      const trace = createAcpTrace(root, '733', 4321, '/bin/agent', ['acp'], '/worktree', true)!
      installAcpStreamTrace(trace, stdin, stdout)
      stdin.write(Buffer.from([0, 1, 255]))
      stdout.write(Buffer.from('reply'))
      for (const stage of ['initialize', 'session/load', 'session/new'] as const) {
        await traceAcpHandshake(trace, stage, async () => {
          trace.marker('request.settled', { stage })
          return 'ok'
        })
      }

      const entries = readFileSync(join(root, '733-4321.acp-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries.map(({ event }) => event)).toEqual([
        'launch',
        'bytes',
        'bytes',
        'handshake.before',
        'request.settled',
        'handshake.after',
        'handshake.before',
        'request.settled',
        'handshake.after',
        'handshake.before',
        'request.settled',
        'handshake.after',
      ])
      expect(entries[1]).toMatchObject({ direction: 'stdin', length: 3, bytesHex: '0001ff' })
      expect(entries[2]).toMatchObject({ direction: 'stdout', length: 5, bytesHex: '7265706c79' })
      expect(entries[3]).toMatchObject({ stage: 'initialize' })
      expect(entries[5]).toMatchObject({ stage: 'initialize' })
      expect(entries[6]).toMatchObject({ stage: 'session/load' })
      expect(entries[8]).toMatchObject({ stage: 'session/load' })
      expect(entries[9]).toMatchObject({ stage: 'session/new' })
      expect(entries[11]).toMatchObject({ stage: 'session/new' })
      expect(entries.every(({ t_ns }) => typeof t_ns === 'string')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('records the true byte length while capping each payload at 2 KiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-acp-trace-cap-'))
    try {
      const trace = createAcpTrace(root, '733', 4322, '/bin/agent', [], '/worktree', false)!
      trace.bytes('stdin', Buffer.alloc(4096, 255))
      const entries = readFileSync(join(root, '733-4322.acp-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries[1]).toMatchObject({ length: 4096, capturedLength: 2048 })
      expect(entries[1]!.bytesHex).toBe('ff'.repeat(2048))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
