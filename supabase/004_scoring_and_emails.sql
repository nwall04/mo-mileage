-- =====================================================================
-- Mo + Mileage  |  Update 004: fairer Overall score + email reminder opt-out
-- ADD-ONLY: safe to run on the live site. It deletes no data.
-- Paste into Supabase > SQL Editor > New query > Run. Running it twice is harmless.
-- =====================================================================

-- 1. Email reminders: everyone is opted in unless they untick the box on their profile.
alter table public.profiles add column if not exists email_ok boolean not null default true;

-- 2. Overall score, out of 100:
--    Distance    40  square root of your km vs the leader's (more km always helps, but the gains taper)
--    Consistency 30  days with at least one activity, out of 30
--    Mustache    30  your votes vs the most-voted person
--    Same columns as before, plus active_days at the end.
create or replace view public.leaderboard as
with counted as (
  select * from public.activities
   where not hidden and not under_review and activity_date >= date '2026-11-01'
), km as (
  select user_id,
         sum(distance_km * public.kind_multiplier(kind)) as km_points,
         sum(distance_km)                                 as raw_km,
         count(*)                                         as activities,
         count(*) filter (where proof_url ~* 'strava')    as strava_linked,
         count(distinct activity_date)                    as active_days
    from counted group by user_id
), mo as (
  select p.user_id, count(v.photo_id) as mo_votes
    from public.mo_photos p join public.votes v on v.photo_id = p.id
   where not p.hidden group by p.user_id
), last_photo as (
  select distinct on (user_id) user_id, storage_path
    from public.mo_photos where not hidden order by user_id, week desc
), base as (
  select pr.id as user_id, pr.display_name, pr.hometown, pr.mo_space_url, pr.strava_url,
         round(coalesce(km.km_points, 0), 1) as km_points,
         round(coalesce(km.raw_km, 0), 1)    as raw_km,
         coalesce(km.activities, 0)          as activities,
         coalesce(mo.mo_votes, 0)            as mo_votes,
         coalesce(pr.avatar_path, lp.storage_path) as photo_path,
         (sc.user_id is not null and coalesce(km.raw_km, 0) <= sc.strava_km * 1.05 + 1) as strava_checked,
         sc.checked_on,
         coalesce(km.active_days, 0)         as active_days,
         coalesce(km.km_points, 0)           as km_exact
    from public.profiles pr
    left join km on km.user_id = pr.id
    left join mo on mo.user_id = pr.id
    left join last_photo lp on lp.user_id = pr.id
    left join public.strava_checks sc on sc.user_id = pr.id
   where pr.is_participant
)
select b.user_id, b.display_name, b.hometown, b.mo_space_url, b.strava_url,
       b.km_points, b.raw_km, b.activities, b.mo_votes, b.photo_path, b.strava_checked, b.checked_on,
       round( 40 * coalesce(sqrt(b.km_exact) / nullif(max(sqrt(b.km_exact)) over (), 0), 0)
            + 30 * least(b.active_days, 30) / 30.0
            + 30 * coalesce(b.mo_votes::numeric / nullif(max(b.mo_votes) over (), 0), 0), 1) as moathlete_score,
       b.active_days
  from base b;

-- 3. Organizer-only list of emails for reminders (everyone else gets zero rows).
create or replace view public.reminder_emails as
select u.email, p.display_name
  from auth.users u join public.profiles p on p.id = u.id
 where p.email_ok and public.is_admin()
 order by p.display_name;
grant select on public.reminder_emails to authenticated;
