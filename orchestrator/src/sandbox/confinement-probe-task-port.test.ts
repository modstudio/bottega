import { expect, test } from 'bun:test'
import { createConnection, type Socket } from 'node:net'
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'
import { WORKER_READ_TOOLS } from '../../../shared/worker-read-tools.ts'
import { startAskLoopback } from '../ask/ask.ts'
import {
  type ConfinementProbeTask,
  confinementProbeProject,
  probeTaskReadCommands,
  probeWorkerRecordDependencies,
} from './confinement-probe-task-port.ts'

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

test("the probe's loopback reads its own fixture task", async () => {
  const keyPrefix = 'DEV'
  const project = confinementProbeProject(
    '01990000-0000-7000-8000-000000000001',
    'probe-project',
    '/probe-project',
    [],
    [keyPrefix],
  )
  const task: ConfinementProbeTask = {
    id: '01990000-0000-7000-8000-000000002623',
    key: `${keyPrefix}-${2623}`,
    project: { name: project.name, recordId: project.recordId },
  }
  const runId = 'confinement-filesystem-probe'
  const token = 'probe-token'
  const loopback = await startAskLoopback(
    runId,
    token,
    probeWorkerRecordDependencies({
      task,
      project,
      runId,
      token,
      spaceId: '01990000-0000-7000-8000-000000000002',
    }),
  )
  const client = new Client({ name: 'probe-loopback-test', version: '1' })
  try {
    await client.connect(socketTransport(loopback.url))
    const result = await client.callTool({
      name: WORKER_READ_TOOLS.task,
      arguments: { key: task.key, project: task.project.name },
    })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { type: 'text'; text: string }).text)).toMatchObject({
      task: {
        id: task.id,
        key: task.key,
        project: task.project.name,
        projectId: task.project.recordId,
        title: 'Verify confined CLI access',
      },
    })
    const refusedKey = probeTaskReadCommands(task, [], 'probe').refused.argv.at(-1)
    if (!refusedKey) throw new Error('probe task read command did not include an out-of-scope key')
    const refused = await client.callTool({
      name: WORKER_READ_TOOLS.task,
      arguments: { key: refusedKey, project: task.project.name },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining('read refused: the requested task is outside run task'),
    })
  } finally {
    await client.close()
    await loopback.close()
  }
})
