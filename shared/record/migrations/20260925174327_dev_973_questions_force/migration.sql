ALTER TABLE "question" FORCE ROW LEVEL SECURITY;
ALTER TABLE "question_mutation_audit" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "question" TO record_actor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "question_mutation_audit" TO record_actor;
