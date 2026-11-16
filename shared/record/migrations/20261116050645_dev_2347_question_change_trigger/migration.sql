CREATE TRIGGER record_change_question
AFTER INSERT OR UPDATE OR DELETE ON public.question
FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
