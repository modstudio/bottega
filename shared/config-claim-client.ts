// concern: hosted-config-claim-client
/** Adds machine-key claim requests to the hosted config transport. */
type Request = <T>(route: string, init?: RequestInit) => Promise<T>

export function configClaimClient(request: Request) {
  return {
    listConfigAccess: () =>
      request<{
        items: Array<{ email: string; role: string; permission: string; configAccess: boolean }>
      }>('/v1/config-access'),
    grantConfigAccess: (email: string) =>
      request<{ granted: true }>('/v1/config-access/grant', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    createMachineKeyClaimChallenge: (keyId: string) =>
      request<{ challengeId: string; enc: string; ciphertext: string; senderPublicKey: string }>(
        `/v1/config/machine-keys/${keyId}/claim-challenge`,
        { method: 'POST' },
      ),
    claimMachineKey: (keyId: string, challengeId: string, nonce: string) =>
      request<{ claimed: true }>(`/v1/config/machine-keys/${keyId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ challengeId, nonce }),
      }),
    revokeMachineKey: (keyId: string) =>
      request<{ revoked: true }>(`/v1/config/machine-keys/${keyId}/revoke`, {
        method: 'POST',
      }),
  }
}
