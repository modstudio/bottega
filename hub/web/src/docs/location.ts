/** Router target supplied by the docs route to presentation components. */
export type DocsLocation = {
  to: '/docs/$scope/$subject/$slug'
  params: { scope: string; subject: string; slug: string }
  search: Record<string, never> | { id: string }
}
