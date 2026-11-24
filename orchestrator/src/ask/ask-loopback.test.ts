import { expect, test } from 'bun:test'
import { createConnection, type Socket } from 'node:net'
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'
import { WORKER_READ_TOOLS } from '../../../shared/worker-read-tools.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { startAskLoopback } from './ask.ts'

function socketTransport(urlValue: string): Transport {
  const url = new URL(urlValue)
  let socket: Socket | undefined
  let buffer = ''
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {
      socket = createConnection({ host: url.hostname, port: Number(url.port) })
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', resolve)
        socket!.once('error', reject)
      })
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line) this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
        }
      })
      socket.on('error', (error) => this.onerror?.(error))
      socket.on('close', () => this.onclose?.())
    },
    async send(message) {
      socket!.write(`${JSON.stringify(message)}\n`)
    },
    async close() {
      socket?.destroy()
    },
  }
}

test('a loopback without dependencies resolves worker scope from the run store', async () => {
  const projectId = fixtureProjectRecordId(db())
  const project = db()
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(projectId)!.name
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    taskRecordId: '01990000-0000-7000-8000-000000002623',
    projectRecordId: projectId,
  })
  db()
    .query('UPDATE run SET launch_key=?,run_token=? WHERE record_id=?')
    .run('DEV-2623', 'token', runId)
  const loopback = await startAskLoopback(runId, 'token')
  const client = new Client({ name: 'default-loopback-test', version: '1' })
  try {
    await client.connect(socketTransport(loopback.url))
    const result = await client.callTool({
      name: WORKER_READ_TOOLS.task,
      arguments: { key: 'DEV-2623', project: `${project}-other` },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining(`outside run project ${project}`),
    })
  } finally {
    await client.close()
    await loopback.close()
  }
})
