INSERT INTO "space" ("id", "name", "created_at")
VALUES ('01990000-0000-7000-8000-000000000001', 'bottega', '2026-09-09T00:00:00Z');

-- The seed must precede FORCE because FORCE confines the table owner too.
ALTER TABLE "space" FORCE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;
ALTER TABLE "seq" FORCE ROW LEVEL SECURITY;
