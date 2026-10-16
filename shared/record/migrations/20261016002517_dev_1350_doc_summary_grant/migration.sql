-- Column grants do not extend to new columns: grant the public role access to summary.
GRANT SELECT (summary) ON TABLE doc TO record_public;
