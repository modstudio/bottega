/**
 * Set above Fly's idle close so the proxy, not the app, ends an idle connection.
 * Bun's unset default drops requests at ten seconds.
 */
export const HOSTED_SERVER_IDLE_TIMEOUT_SECONDS = 75
