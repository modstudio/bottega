-- Column grants do not extend to a new column: re-issue the public role's read list with featured.
REVOKE ALL ON TABLE doc FROM record_public;
GRANT SELECT (
  id, space_id, scope, subject, owner_user_id, slug, title, body, audience, featured,
  parent_id, position, updated_at, deleted_at, search_vector
) ON TABLE doc TO record_public;
