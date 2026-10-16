import { readEnvValues } from '../../shared/env-values.ts'

/** Resolve the hosted hub address from process, Bottega config, then harness configuration. */
export function resolveHostedUrl(): string | undefined {
  return readEnvValues(['HUB_HOSTED_URL']).HUB_HOSTED_URL
}
