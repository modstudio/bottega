import { createFileRoute } from '@tanstack/react-router'

type DocSearch = { edit?: boolean; id?: string; revision?: string | number }

export const Route = createFileRoute('/docs/$scope/$subject/$slug')({
  validateSearch: (search: Record<string, unknown>): DocSearch => ({
    edit: search.edit === true || search.edit === '1' || search.edit === 'true' ? true : undefined,
    id: typeof search.id === 'string' ? search.id : undefined,
    revision:
      typeof search.revision === 'string' || typeof search.revision === 'number'
        ? search.revision
        : undefined,
  }),
  component: function DocRoute() {
    return null
  },
})
