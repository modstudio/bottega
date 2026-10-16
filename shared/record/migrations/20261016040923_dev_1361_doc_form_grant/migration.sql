-- Column grants do not extend to new columns: grant the public role access to form.
GRANT SELECT (form) ON TABLE doc TO record_public;
