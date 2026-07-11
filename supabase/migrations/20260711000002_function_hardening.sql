-- Harden the internal helper functions flagged by the security advisor:
-- pin their search_path and make them non-callable through the PostgREST
-- RPC surface. Triggers keep firing — trigger execution doesn't require
-- the acting user to hold EXECUTE.

alter function public.set_updated_at() set search_path = '';

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
