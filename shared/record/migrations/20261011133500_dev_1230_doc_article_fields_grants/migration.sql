ALTER TABLE doc_related_subject FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE doc_related_subject TO record_actor;
GRANT SELECT ON TABLE doc_related_subject TO record_reader;
GRANT SELECT, INSERT, UPDATE (form, article_subject_id, source_files) ON TABLE doc TO record_actor;
GRANT SELECT (form, article_subject_id, source_files) ON TABLE doc TO record_reader;
GRANT SELECT, INSERT (form, article_subject_id, related_subject_ids, source_files) ON TABLE doc_revision TO record_actor;
GRANT SELECT (form, article_subject_id, related_subject_ids, source_files) ON TABLE doc_revision TO record_reader;
