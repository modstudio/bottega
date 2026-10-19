/** Router target supplied by the docs route to navigation helpers. */
export type DocsLocation = {
  to: '/docs/$scope/$subject/$slug'
  params: { scope: string; subject: string; slug: string }
  search: { id?: never } | { id: string }
}
