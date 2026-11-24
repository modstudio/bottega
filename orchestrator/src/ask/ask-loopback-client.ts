import { type RequestOptions, request } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { askAuthPreamble } from './ask-loopback-auth.ts'

const ASK_URL_REFUSAL = 'BOTTEGA_ASK_URL must name a tcp://127.0.0.1:<port> endpoint'
const LINUX_DIRECT_REMEDY =
  "No HTTP proxy is set on Linux. Run the worker under SRT's network bridge."
const NON_LOOPBACK_PROXY_REMEDY =
  "HTTP proxy must be on 127.0.0.1, ::1, or localhost. Run the worker under SRT's network bridge."
const HANDSHAKE_REMEDY = 'Re-dispatch the run from current main.'

export type AskLoopbackConnection =
  | { kind: 'direct'; host: '127.0.0.1'; port: number; linuxWithoutProxy: boolean }
  | { kind: 'tunnel'; askHost: '127.0.0.1'; askPort: number; proxy: string }

export type AskLoopbackConnectionInput = {
  platform: NodeJS.Platform
  askUrl: string
  HTTP_PROXY?: string
  http_proxy?: string
}

/** Decide whether the ask connection needs SRT's Linux network bridge. */
export function decideAskLoopbackConnection(
  input: AskLoopbackConnectionInput,
): AskLoopbackConnection {
  const url = new URL(input.askUrl)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error(ASK_URL_REFUSAL)
  }
  const port = Number(url.port)
  const proxy = input.HTTP_PROXY || input.http_proxy
  if (input.platform === 'linux' && proxy) {
    return { kind: 'tunnel', askHost: '127.0.0.1', askPort: port, proxy }
  }
  return {
    kind: 'direct',
    host: '127.0.0.1',
    port,
    linuxWithoutProxy: input.platform === 'linux',
  }
}

/** Build the credential-bearing options consumed only by node:http. */
export function askProxyConnectOptions(
  proxyValue: string,
  askHost: string,
  askPort: number,
): RequestOptions {
  let proxy: URL
  try {
    proxy = new URL(proxyValue)
  } catch {
    throw new Error('HTTP proxy must be a valid http:// URL')
  }
  if (proxy.protocol !== 'http:' || !proxy.hostname) {
    throw new Error('HTTP proxy must be a valid http:// URL')
  }
  const hostname = proxy.hostname.toLowerCase()
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname)) {
    throw new Error(NON_LOOPBACK_PROXY_REMEDY)
  }
  const target = `${askHost}:${askPort}`
  const headers: Record<string, string> = { Host: target }
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
  }
  return {
    host: proxy.hostname,
    port: proxy.port ? Number(proxy.port) : 80,
    method: 'CONNECT',
    path: target,
    headers,
  }
}

function directSocket(
  connection: Extract<AskLoopbackConnection, { kind: 'direct' }>,
): Promise<Socket> {
  const socket = createConnection({ host: connection.host, port: connection.port })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', (error) => {
      reject(
        connection.linuxWithoutProxy ? new Error(`${error.message} ${LINUX_DIRECT_REMEDY}`) : error,
      )
    })
  })
}

function tunnelSocket(
  connection: Extract<AskLoopbackConnection, { kind: 'tunnel' }>,
): Promise<Socket> {
  const options = askProxyConnectOptions(connection.proxy, connection.askHost, connection.askPort)
  return new Promise((resolve, reject) => {
    const proxyRequest = request(options)
    proxyRequest.once('connect', (response, socket, head) => {
      if (
        response.statusCode === undefined ||
        response.statusCode < 200 ||
        response.statusCode >= 300
      ) {
        socket.destroy()
        reject(
          new Error(
            `Ask proxy CONNECT through ${String(options.host)}:${String(options.port)} failed with status ${String(response.statusCode ?? 'unknown')}`,
          ),
        )
        return
      }
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    proxyRequest.once('error', reject)
    proxyRequest.end()
  })
}

export function openAskLoopbackSocket(connection: AskLoopbackConnection): Promise<Socket> {
  return connection.kind === 'direct' ? directSocket(connection) : tunnelSocket(connection)
}

export function requireAskRunToken(token: string | undefined): string {
  if (!token) throw new Error('BOTTEGA_RUN_TOKEN is required for the ask loopback')
  return token
}

export function askHandshakeClosedError(): Error {
  return new Error(`Ask loopback closed before accepting the handshake. ${HANDSHAKE_REMEDY}`)
}

/** Forward stdio to the database-owning ask loopback. */
export async function connectAskLoopback(urlValue: string): Promise<void> {
  const token = requireAskRunToken(process.env.BOTTEGA_RUN_TOKEN)
  const connection = decideAskLoopbackConnection({
    platform: process.platform,
    askUrl: urlValue,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
  })
  const socket = await openAskLoopbackSocket(connection)
  socket.write(askAuthPreamble(token))
  let receivedMcpBytes = false
  socket.on('data', () => {
    receivedMcpBytes = true
  })
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  await new Promise<void>((resolve, reject) => {
    socket.once('close', () => {
      if (receivedMcpBytes) resolve()
      else reject(askHandshakeClosedError())
    })
    socket.once('error', reject)
  })
}
