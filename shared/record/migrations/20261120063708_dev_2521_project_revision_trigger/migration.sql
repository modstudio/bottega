CREATE TRIGGER project_revision_bump
BEFORE UPDATE ON public.project
FOR EACH ROW EXECUTE FUNCTION public.hub_guarded_revision_bump();
