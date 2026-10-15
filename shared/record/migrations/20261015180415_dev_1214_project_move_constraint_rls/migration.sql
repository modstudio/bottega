-- PGlite validates the replacement composite foreign key through project RLS.
-- Suspend RLS until the constraint is installed, then restore it immediately.
ALTER TABLE "project" DISABLE ROW LEVEL SECURITY;
