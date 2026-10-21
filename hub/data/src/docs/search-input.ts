import type { DocAudience } from '../../../../shared/docs.ts'

export function docsSearchInputs(
  query: string,
  audience: DocAudience | null,
  subject: string | undefined,
  includeDrafts: boolean,
  includeWorking: boolean,
) {
  return {
    local: { query, audience: audience ?? undefined, subject, includeDrafts, includeWorking },
    hosted: {
      query,
      audience: audience ?? undefined,
      subject,
      includeDrafts,
      includeWorking,
      acrossReadableSpaces: true as const,
    },
    public: { query },
  }
}
