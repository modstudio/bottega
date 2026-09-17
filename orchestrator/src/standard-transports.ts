// concern: standard-transports
/** Registers the concrete transport adapters selected by application entrypoints. */
import { registerAcpTransport } from './transport/transport-acp.ts'
import { registerCliTransport } from './transport/transport-cli.ts'

export function registerStandardTransports(): void {
  registerCliTransport()
  registerAcpTransport()
}
