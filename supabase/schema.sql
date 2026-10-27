-- =====================================================================
-- Mo + Mileage  |  Supabase schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- WARNING: block 0 deletes all app data. Run the full file only before
-- launch. After launch, re-run individual functions instead.
-- =====================================================================

-- ---------- 0. Clean slate ---------------------------------------------
drop view  if exists public.leaderboard, public.team_totals,
                     public.activity_feed, public.mo_gallery, public.review_queue cascade;
drop table if exists public.activity_flags, public.strava_checks, public.votes, public.mo_photos,
                     public.activities, public.site_settings, public.admins, public.profiles cascade;
drop type  if exists public.activity_kind cascade;

-- ---------- 1. Challenge calendar (Ottawa time) ------------------------
create or replace function public.local_date(ts timestamptz default now())
returns date language sql stable as $$
  select (ts at time zone 'America/Toronto')::date
$$;

-- Week 0 = Shave-Down (before Nov 1), 1-4 = voting weeks, null = over.
create or replace function public.mo_week(ts timestamptz default now())
returns smallint language sql stable as $$
  select case
    when public.local_date(ts) <  date '2026-11-01' then 0
    when public.local_date(ts) <= date '2026-11-07' then 1
    when public.local_date(ts) <= date '2026-11-14' then 2
    when public.local_date(ts) <= date '2026-11-21' then 3
    when public.local_date(ts) <= date '2026-11-30' then 4
    else null
  end::smallint
$$;

-- Logging, flagging and voting close at the end of Dec 2.
create or replace function public.grace_open(ts timestamptz default now())
returns boolean language sql stable as $$
  select public.local_date(ts) <= date '2026-12-02'
$$;

-- ---------- 2. Tables --------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text not null check (char_length(btrim(display_name)) between 2 and 40),
  hometown       text check (hometown is null or char_length(hometown) <= 60),
  mo_space_url   text check (mo_space_url is null or mo_space_url ~* '^https://([a-z]+\.)?movember\.com/'),
  strava_url     text check (strava_url  is null or strava_url  ~* '^https://(www\.)?strava\.(com|app\.link)/'),
  is_participant boolean not null default true,
  created_at     timestamptz not null default now()
);

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create type public.activity_kind as enum ('run','walk','hike','wheelchair','cycle','swim');

-- Points per km.
create or replace function public.kind_multiplier(k public.activity_kind)
returns numeric language sql immutable as $$
  select case k when 'cycle' then 0.33 when 'swim' then 4 else 1 end::numeric
$$;

-- Fastest believable pace (minutes per km) before an entry goes to review.
-- run 2:45/km, walk or hike 6:30/km (~9 km/h), wheelchair 2:00/km,
-- bike 1:12/km (~50 km/h), swim 10:00/km (1:00 per 100 m).
create or replace function public.min_pace(k public.activity_kind)
returns numeric language sql immutable as $$
  select case k when 'run' then 2.75 when 'walk' then 6.5 when 'hike' then 6.5
                when 'wheelchair' then 2.0 when 'cycle' then 1.2 when 'swim' then 10 end::numeric
$$;

create table public.activities (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  activity_date date not null check (activity_date between date '2026-11-01' and date '2026-11-30'),
  kind          public.activity_kind not null,
  distance_km   numeric(6,2) not null check (distance_km > 0),
  duration_min  numeric(6,1) not null check (duration_min between 1 and 1440),
  proof_url     text check (proof_url is null or proof_url ~* '^https://'),
  proof_path    text,               -- screenshot in the "proof" bucket
  proof_hash    text,               -- SHA-256 of the original screenshot file
  note          text check (note is null or char_length(note) <= 140),
  under_review  boolean not null default false,  -- not counted until the organizer clears it
  review_reason text,
  cleared       boolean not null default false,  -- organizer approved; flags no longer re-trigger review
  hidden        boolean not null default false,  -- organizer removed it
  created_at    timestamptz not null default now(),
  constraint proof_required check (proof_url is not null or proof_path is not null)
);
create index on public.activities (user_id);
create index on public.activities (created_at desc);
-- The same Strava link or the same screenshot can only be claimed once, by anyone.
create unique index activities_proof_url_once  on public.activities (lower(proof_url)) where proof_url is not null;
create unique index activities_proof_hash_once on public.activities (proof_hash) where proof_hash is not null;

create table public.activity_flags (
  activity_id bigint not null references public.activities(id) on delete cascade,
  flagger_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reason      text not null check (char_length(btrim(reason)) between 3 and 140),
  created_at  timestamptz not null default now(),
  primary key (activity_id, flagger_id)
);

-- Organizer's weekly check against the Strava Group Challenge leaderboard.
create table public.strava_checks (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  strava_km  numeric(7,2) not null check (strava_km >= 0),
  checked_on date not null default public.local_date()
);

create table public.mo_photos (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  week         smallint not null,
  storage_path text not null,
  caption      text check (caption is null or char_length(caption) <= 80),
  hidden       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (user_id, week)
);

create table public.votes (
  voter_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  photo_id   bigint not null references public.mo_photos(id) on delete cascade,
  week       smallint not null,
  created_at timestamptz not null default now(),
  primary key (voter_id, photo_id)
);

create table public.site_settings (
  id            int primary key default 1 check (id = 1),
  raised_amount numeric(10,2) not null default 0,
  goal_amount   numeric(10,2) not null default 2500,
  announcement  text check (announcement is null or char_length(announcement) <= 200),
  updated_at    timestamptz not null default now()
);
insert into public.site_settings (id) values (1);

-- ---------- 3. Helpers -------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- ---------- 4. Guard-rail triggers ------------------------------------
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
  cap := case new.kind when 'cycle' then 300 when 'swim' then 15 else 100 end;
  if new.distance_km > cap then
    raise exception 'Max % km for one % entry. Split it up or message the organizer.', cap, new.kind;
  end if;
  select count(*) into today_count from public.activities
   where user_id = auth.uid() and created_at > now() - interval '1 day';
  if today_count >= 10 then
    raise exception 'That is a lot of entries for one day. Try again tomorrow.';
  end if;

  -- Normalize Strava activity links so the same activity cannot be claimed twice.
  if new.proof_url ~* 'strava\.com/activities/[0-9]+' then
    new.proof_url := 'https://www.strava.com/activities/' || substring(new.proof_url from '(?i)activities/([0-9]+)');
  end if;

  new.user_id      := auth.uid();
  new.hidden       := false;
  new.cleared      := false;
  new.under_review := false;
  new.review_reason := null;

  pace := new.duration_min / new.distance_km;
  if pace < public.min_pace(new.kind) then
    new.under_review  := true;
    new.review_reason := format('Pace check: %s min/km is faster than the %s limit', round(pace, 2), new.kind);
  end if;
  return new;
end $$;

create trigger activities_guard before insert or update on public.activities
for each row execute function public.activities_guard();

create or replace function public.flags_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a public.activities;
  n int;
begin
  if not public.grace_open() then
    raise exception 'Flagging is closed.';
  end if;
  select * into a from public.activities where id = new.activity_id;
  if a.id is null or a.hidden then
    raise exception 'That entry is not available.';
  end if;
  if a.user_id = auth.uid() then
    raise exception 'You cannot flag your own entry. Delete it instead.';
  end if;
  new.flagger_id := auth.uid();
  return new;
end $$;

create trigger flags_guard before insert on public.activity_flags
for each row execute function public.flags_guard();

-- Three flags from different people send an entry to review (unless the organizer already cleared it).
create or replace function public.flags_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.activities a
     set under_review = true,
         review_reason = coalesce(a.review_reason || '; ', '') || 'Flagged by 3 people'
   where a.id = new.activity_id
     and not a.cleared and not a.under_review
     and (select count(*) from public.activity_flags f where f.activity_id = new.activity_id) >= 3;
  return null;
end $$;

create trigger flags_after after insert on public.activity_flags
for each row execute function public.flags_after();

create or replace function public.mo_photos_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    return new;
  end if;
  new.week := public.mo_week();
  if new.week is null then
    raise exception 'Mo photo uploads are closed.';
  end if;
  if new.storage_path not like auth.uid()::text || '/%' then
    raise exception 'Bad photo path.';
  end if;
  new.user_id := auth.uid();
  new.hidden  := false;
  return new;
end $$;

create trigger mo_photos_guard before insert or update on public.mo_photos
for each row execute function public.mo_photos_guard();

create or replace function public.votes_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p public.mo_photos;
  used int;
begin
  if not public.grace_open() then
    raise exception 'Voting is closed.';
  end if;
  select * into p from public.mo_photos where id = new.photo_id;
  if p.id is null or p.hidden then
    raise exception 'That photo is not available.';
  end if;
  if p.week = 0 then
    raise exception 'Shave-Down photos are for laughs, not votes.';
  end if;
  if p.user_id = auth.uid() then
    raise exception 'Nice try. You cannot vote for your own mo.';
  end if;
  select count(*) into used from public.votes where voter_id = auth.uid() and week = p.week;
  if used >= 3 then
    raise exception 'You have used all 3 votes for week %. Remove one to vote again.', p.week;
  end if;
  new.voter_id := auth.uid();
  new.week     := p.week;
  return new;
end $$;

create trigger votes_guard before insert on public.votes
for each row execute function public.votes_guard();

-- ---------- 5. Row-level security -------------------------------------
alter table public.profiles       enable row level security;
alter table public.admins         enable row level security;
alter table public.activities     enable row level security;
alter table public.activity_flags enable row level security;
alter table public.strava_checks  enable row level security;
alter table public.mo_photos      enable row level security;
alter table public.votes          enable row level security;
alter table public.site_settings  enable row level security;

create policy "profiles readable"   on public.profiles for select using (true);
create policy "profiles insert own" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- admins: no policies, so no API access at all

create policy "activities read own or admin" on public.activities for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "activities insert own" on public.activities for insert to authenticated
  with check (user_id = auth.uid());
create policy "activities delete own or admin" on public.activities for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "activities admin review" on public.activities for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "flags read own or admin" on public.activity_flags for select to authenticated
  using (flagger_id = auth.uid() or public.is_admin());
create policy "flags insert own" on public.activity_flags for insert to authenticated
  with check (flagger_id = auth.uid());
create policy "flags admin delete" on public.activity_flags for delete to authenticated
  using (public.is_admin());

create policy "strava checks admin" on public.strava_checks for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "photos readable" on public.mo_photos for select
  using (not hidden or user_id = auth.uid() or public.is_admin());
create policy "photos insert own" on public.mo_photos for insert to authenticated
  with check (user_id = auth.uid());
create policy "photos delete own or admin" on public.mo_photos for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "photos admin hide" on public.mo_photos for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "votes read own"   on public.votes for select to authenticated using (voter_id = auth.uid());
create policy "votes insert own" on public.votes for insert to authenticated with check (voter_id = auth.uid());
create policy "votes delete own" on public.votes for delete to authenticated
  using (voter_id = auth.uid() and public.grace_open());

create policy "settings readable" on public.site_settings for select using (true);
create policy "settings admin"    on public.site_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Column-level lock: only the organizer's review fields can ever be updated.
revoke update on public.activities, public.mo_photos, public.votes, public.site_settings,
                 public.activity_flags from anon, authenticated;
grant  update (hidden, under_review, cleared) on public.activities to authenticated;
grant  update (hidden) on public.mo_photos to authenticated;
grant  update (raised_amount, goal_amount, announcement, updated_at) on public.site_settings to authenticated;

-- ---------- 6. Public read-only views ----------------------------------
-- Views run as their owner: they aggregate everyone's rows but expose only
-- totals and public fields. Entries under review or hidden do not count.

create view public.leaderboard as
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
         lp.storage_path                     as photo_path,
         -- "Strava checked": organizer's latest check covers what this person claims (5% + 1 km leeway)
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

create view public.team_totals as
select
  (select count(*) from public.profiles where is_participant) as participants,
  (select round(coalesce(sum(distance_km), 0), 1) from public.activities where not hidden and not under_review) as total_km,
  (select count(*) from public.leaderboard where km_points >= 60) as hit_60,
  (select count(*) from public.mo_photos where not hidden)        as mo_photos;

create view public.activity_feed as
select a.id, a.user_id, pr.display_name, a.activity_date, a.kind, a.distance_km, a.duration_min,
       round(a.distance_km * public.kind_multiplier(a.kind), 1) as points,
       a.proof_url, a.proof_path, a.note, a.under_review, a.created_at
  from public.activities a join public.profiles pr on pr.id = a.user_id
 where not a.hidden;

create view public.mo_gallery as
select p.id, p.user_id, pr.display_name, p.week, p.storage_path, p.caption, p.created_at,
       (select count(*) from public.votes v where v.photo_id = p.id) as votes
  from public.mo_photos p join public.profiles pr on pr.id = p.user_id
 where not p.hidden;

-- Organizer-only queue. The is_admin() filter means everyone else gets zero rows.
create view public.review_queue as
select a.id, pr.display_name, a.activity_date, a.kind, a.distance_km, a.duration_min,
       round(a.duration_min / a.distance_km, 2) as pace_min_km,
       a.proof_url, a.proof_path, a.note, a.review_reason, a.created_at,
       (select string_agg(f.reason, ' | ') from public.activity_flags f where f.activity_id = a.id) as flag_reasons
  from public.activities a join public.profiles pr on pr.id = a.user_id
 where a.under_review and not a.hidden and public.is_admin();

grant select on public.leaderboard, public.team_totals, public.activity_feed, public.mo_gallery
  to anon, authenticated;
grant select on public.review_queue to authenticated;

-- ---------- 7. Storage buckets ----------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mo-photos', 'mo-photos', true, 6291456, array['image/jpeg','image/png','image/webp']),
       ('proof',     'proof',     true, 6291456, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "mm upload own folder" on storage.objects;
drop policy if exists "mm delete own folder" on storage.objects;
create policy "mm upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id in ('mo-photos','proof')
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mm delete own folder" on storage.objects for delete to authenticated
  using (bucket_id in ('mo-photos','proof')
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------- 8. Make yourself the organizer -----------------------------
-- After you sign in on the site once, run this with your email:
-- insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
