-- Column grants do not extend to new columns: grant the public role access to audiences.
GRANT SELECT (audiences) ON TABLE doc TO record_public;
