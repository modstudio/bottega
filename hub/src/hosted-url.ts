import { readEnvValues } from '../../shared/env-values.ts'

/** Resolve the hosted hub address from process, Bottega config, then harness configuration. */
export function resolveHostedUrl(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return readEnvValues(['HUB_HOSTED_URL'], environment).HUB_HOSTED_URL
}
