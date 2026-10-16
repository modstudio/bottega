import type { ConfigEnvironment } from '../../shared/config-directory.ts'
import { readEnvValues } from '../../shared/env-values.ts'

/** Resolve the hosted hub address from process, Bottega config, then harness configuration. */
export function resolveHostedUrl(environment: ConfigEnvironment = process.env): string | undefined {
  return readEnvValues(['HUB_HOSTED_URL'], environment).HUB_HOSTED_URL
}
