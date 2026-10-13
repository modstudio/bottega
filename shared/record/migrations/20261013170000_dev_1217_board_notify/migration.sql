CREATE FUNCTION public.notify_board_message_advanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_notify('record_board_message_advanced', '');
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER board_message_notify_advanced
AFTER INSERT OR UPDATE ON public.board_message
FOR EACH STATEMENT
EXECUTE FUNCTION public.notify_board_message_advanced();
