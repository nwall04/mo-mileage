-- =====================================================================
-- Mo + Mileage  |  Update 005: fix Supabase security warning "auth_users_exposed"
-- Removes the reminder_emails view (which read auth.users) and replaces it with
-- an organizer-only function. Deletes no data. Safe to run twice.
-- Paste into Supabase > SQL Editor > New query > Run.
-- =====================================================================

drop view if exists public.reminder_emails;

create or replace function public.admin_reminder_emails()
returns table (email text, display_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Organizer only.';
  end if;
  return query
    select u.email::text, p.display_name
      from auth.users u join public.profiles p on p.id = u.id
     where p.email_ok
     order by p.display_name;
end $$;

-- Only signed-in people can even call it, and the check above stops everyone but the organizer.
revoke all on function public.admin_reminder_emails() from public, anon;
grant execute on function public.admin_reminder_emails() to authenticated;
