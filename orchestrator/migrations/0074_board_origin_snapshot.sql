ALTER TABLE board_message ADD COLUMN author_harness TEXT;
ALTER TABLE board_message ADD COLUMN author_project TEXT;

UPDATE board_message
SET author_harness = (
      SELECT harness FROM presence WHERE presence.session_id = board_message.author_session
    ),
    author_project = (
      SELECT project FROM presence WHERE presence.session_id = board_message.author_session
    )
WHERE author_kind = 'architect';
