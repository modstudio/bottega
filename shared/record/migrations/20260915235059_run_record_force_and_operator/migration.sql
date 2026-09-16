ALTER TABLE "run" FORCE ROW LEVEL SECURITY;

-- Stand-in identity until Better Auth owns users.
INSERT INTO "user" ("id", "email", "name", "created_at")
VALUES (
  '01990000-0000-7000-8000-000000000002',
  'operator@bottega.local',
  'Platform Operator',
  '2026-09-15T00:00:00Z'
);

SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);
INSERT INTO "membership" ("id", "space_id", "user_id", "role", "permission", "created_at")
VALUES (
  '01990000-0000-7000-8000-000000000003',
  '01990000-0000-7000-8000-000000000001',
  '01990000-0000-7000-8000-000000000002',
  'operator',
  'write',
  '2026-09-15T00:00:00Z'
);
