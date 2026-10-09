import type { DocsAudience } from './types.ts'

export function docsSearchInputs(
  query: string,
  audience: DocsAudience | null,
  subject: string | undefined,
  includeDrafts: boolean,
) {
  return {
    local: { query, audience: audience ?? undefined, subject, includeDrafts },
    hosted: {
      query,
      audience: audience ?? undefined,
      subject,
      includeDrafts,
      acrossReadableSpaces: true as const,
    },
    public: { query },
  }
}
