ALTER TABLE board_reach_delivery ADD COLUMN emission_id TEXT;

CREATE UNIQUE INDEX board_reach_delivery_emission_message
ON board_reach_delivery(emission_id,message_source,message_id)
WHERE emission_id IS NOT NULL;
