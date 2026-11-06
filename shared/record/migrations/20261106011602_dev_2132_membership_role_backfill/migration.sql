ALTER TABLE "membership" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitation" NO FORCE ROW LEVEL SECURITY;

UPDATE membership SET role = 'member' WHERE role = 'operator';
UPDATE invitation SET role = 'member' WHERE role = 'operator';

ALTER TABLE "invitation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
