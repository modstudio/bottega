// concern: standard-transports
/** Registers the concrete transport adapters selected by application entrypoints. */
import { registerAcpTransport } from './transport-acp.ts'
import { registerCliTransport } from './transport-cli.ts'

export function registerStandardTransports(): void {
  registerCliTransport()
  registerAcpTransport()
}
