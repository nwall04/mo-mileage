-- =====================================================================
-- Mo + Mileage  |  Update 003: practice mode and a review-everything queue
-- ADD-ONLY: safe to run on the live site. It deletes no data.
-- Paste into Supabase > SQL Editor > New query > Run. Running it twice is harmless.
-- =====================================================================

-- 1. Practice entries: allow dates from Oct 25 so people can try logging before
--    November. Anything dated before Nov 1 never counts and disappears from the
--    feed on Nov 1.
alter table public.activities drop constraint if exists activities_activity_date_check;
alter table public.activities add constraint activities_activity_date_check
  check (activity_date between date '2026-10-25' and date '2026-11-30');

create or replace function public.activities_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cap numeric;
  today_count int;
  pace numeric;
begin
  if tg_op = 'UPDATE' then
    return new;   -- only admins reach UPDATE (column grants + policy)
  end if;
  if not public.grace_open() then
    raise exception 'Logging is closed. Thanks for moving!';
  end if;
  if new.activity_date > public.local_date() then
    raise exception 'That date is in the future.';
  end if;
  if new.activity_date < date '2026-11-01' and public.local_date() >= date '2026-11-01' then
    raise exception 'Practice is over. Log activities from November 1 onward.';
  end if;
  cap := case new.kind when 'cycle' then 300 when 'swim' then 15 else 100 end;
  if new.distance_km > cap then
    raise exception 'Max % km for one % entry. Split it up or message the organizer.', cap, new.kind;
  end if;
  select count(*) into today_count from public.activities
   where user_id = auth.uid() and created_at > now() - interval '1 day';
  if today_count >= 10 then
    raise exception 'That is a lot of entries for one day. Try again tomorrow.';
  end if;

  if new.proof_url ~* 'strava\.com/activities/[0-9]+' then
    new.proof_url := 'https://www.strava.com/activities/' || substring(new.proof_url from '(?i)activities/([0-9]+)');
  end if;

  new.user_id       := auth.uid();
  new.hidden        := false;
  new.cleared       := false;
  new.under_review  := false;
  new.review_reason := null;

  pace := new.duration_min / new.distance_km;
  if pace < public.min_pace(new.kind) then
    new.under_review  := true;
    new.review_reason := format('Pace check: %s min/km is faster than the %s limit', round(pace, 2), new.kind);
  end if;
  return new;
end $$;

-- 2. Standings and totals ignore practice entries. Same columns as before.
create or replace view public.leaderboard as
with counted as (
  select * from public.activities
   where not hidden and not under_review and activity_date >= date '2026-11-01'
), km as (
  select user_id,
         sum(distance_km * public.kind_multiplier(kind)) as km_points,
         sum(distance_km)                                 as raw_km,
         count(*)                                         as activities,
         count(*) filter (where proof_url ~* 'strava')    as strava_linked
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
         sc.checked_on
    from public.profiles pr
    left join km on km.user_id = pr.id
    left join mo on mo.user_id = pr.id
    left join last_photo lp on lp.user_id = pr.id
    left join public.strava_checks sc on sc.user_id = pr.id
   where pr.is_participant
)
select b.*,
       round( 50 * coalesce(b.km_points / nullif(max(b.km_points) over (), 0), 0)
            + 50 * coalesce(b.mo_votes::numeric / nullif(max(b.mo_votes) over (), 0), 0), 1) as moathlete_score
  from base b;

create or replace view public.team_totals as
select
  (select count(*) from public.profiles where is_participant) as participants,
  (select round(coalesce(sum(distance_km), 0), 1) from public.activities
    where not hidden and not under_review and activity_date >= date '2026-11-01') as total_km,
  (select count(*) from public.leaderboard where km_points >= 60) as hit_60,
  (select count(*) from public.mo_photos where not hidden)        as mo_photos;

-- 3. Feed: practice entries show (tagged) only until Nov 1; adds "checked" and "practice" flags.
create or replace view public.activity_feed as
select a.id, a.user_id, pr.display_name, a.activity_date, a.kind, a.distance_km, a.duration_min,
       round(a.distance_km * public.kind_multiplier(a.kind), 1) as points,
       a.proof_url, a.proof_path, a.note, a.under_review, a.created_at,
       a.cleared as checked,
       (a.activity_date < date '2026-11-01') as practice
  from public.activities a join public.profiles pr on pr.id = a.user_id
 where not a.hidden
   and (a.activity_date >= date '2026-11-01' or public.local_date() < date '2026-11-01');

-- 4. Organizer queue: every entry not yet approved or removed (paused ones included).
create or replace view public.review_queue as
select a.id, pr.display_name, a.activity_date, a.kind, a.distance_km, a.duration_min,
       round(a.duration_min / a.distance_km, 2) as pace_min_km,
       a.proof_url, a.proof_path, a.note, a.review_reason, a.created_at,
       (select string_agg(f.reason, ' | ') from public.activity_flags f where f.activity_id = a.id) as flag_reasons,
       a.under_review,
       a.user_id,
       (a.activity_date < date '2026-11-01') as practice
  from public.activities a join public.profiles pr on pr.id = a.user_id
 where not a.cleared and not a.hidden and public.is_admin();
