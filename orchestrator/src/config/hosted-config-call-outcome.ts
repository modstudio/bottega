// concern: hosted-config-call-outcome
/** Adapts hosted config observations into the machine-local outcome store. */

import {
  type ConfigCallObservation,
  type ConfigClient,
  configClient,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { classifyHostedTransportError, recordHostedCallOutcome } from '../hosted-call-outcome.ts'

function configRouteClass(path: string): string {
  const pathname = path.split('?', 1)[0] ?? path
  if (pathname.includes('/machine-keys')) return 'config-machine-keys'
  if (pathname.includes('/data-keys')) return 'config-data-keys'
  if (pathname.includes('/secrets')) return 'config-secrets'
  if (pathname.includes('/entries')) return 'config-entries'
  return 'config-identity'
}

export function recordConfigCallOutcome(observation: ConfigCallObservation): void {
  recordHostedCallOutcome({
    observedAt: observation.observedAt,
    routeClass: configRouteClass(observation.route),
    httpStatus: observation.status,
    transportError:
      observation.error === null ? null : classifyHostedTransportError(observation.error),
    latencyMs: observation.latencyMs,
  })
}

export function hostedConfigClient(
  env: ConfigEnvironment = process.env,
  transport: Parameters<typeof configClient>[1] = fetch,
  token?: string | null,
  signal?: AbortSignal,
): ConfigClient {
  return configClient(env, transport, token, signal, recordConfigCallOutcome)
}
