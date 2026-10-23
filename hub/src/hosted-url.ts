import { readEnvValues } from '../../shared/env-values.ts'

/** Resolve the hosted hub address from process, Bottega config, then harness configuration. */
export function resolveHostedUrl(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return readEnvValues(['BOTTEGA_HOSTED_URL'], environment).BOTTEGA_HOSTED_URL
}
