export type RepositoryVisibility = 'public' | 'private'

export function repositoryVisibility(value: unknown): RepositoryVisibility | null {
  return value === 'public' || value === 'private' ? value : null
}
