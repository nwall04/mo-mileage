-- =====================================================================
-- Mo + Mileage  |  Update 002: profile photos and bios
-- ADD-ONLY: safe to run on the live site. It deletes nothing.
-- Paste into Supabase > SQL Editor > New query > Run. Running it twice is harmless.
-- =====================================================================

-- New profile fields
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles add column if not exists bio text;

-- Bios max 280 characters; a profile photo must live in that person's own folder
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles add constraint profiles_bio_len
  check (bio is null or char_length(bio) <= 280);
alter table public.profiles drop constraint if exists profiles_avatar_own_folder;
alter table public.profiles add constraint profiles_avatar_own_folder
  check (avatar_path is null or avatar_path like id::text || '/%');

-- Standings show your profile photo first, then your latest mustache photo.
-- Same columns as before, so nothing that reads this view breaks.
create or replace view public.leaderboard as
with counted as (
  select * from public.activities where not hidden and not under_review
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
