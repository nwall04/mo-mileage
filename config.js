// =====================================================================
// Mo + Mileage settings. This is the only file you need to edit.
// Until SUPABASE_URL is filled in, the site runs in read-only demo mode.
// =====================================================================
export const CONFIG = {
  // Supabase > Project Settings > API
  SUPABASE_URL: 'https://oaymwvylcfqgdncidvrq.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_9z7Zwdu0uQS1rfkyxmVTyw_23RY6_zY',

  SITE_NAME: 'Mo + Mileage',
  TAGLINE: 'Grow a mo. Log the kilometres. Out-move November.',

  // Movember team "Mo + Mileage"
  MOVEMBER_TEAM_URL: 'https://movember.com/t/mo-mileage',
  DONATE_URL: 'https://ca.movember.com/donate/details?teamId=2508769',

  // Paste the invite link to your Strava Group Challenge (and club, if you make one)
  STRAVA_CHALLENGE_URL: '',
  STRAVA_CLUB_URL: '',

  // Organizer contact shown on the rules page
  ORGANIZER_NAME: 'Noah',
  ORGANIZER_EMAIL: '',

  TIMEZONE: 'America/Toronto',
  GOAL_KM_EACH: 60,

  // Must match public.mo_week() in supabase/schema.sql
  WEEKS: [
    { n: 0, label: 'Shave-Down', start: '2026-10-25', end: '2026-10-31', note: 'Clean-shaven "before" photo. Not voted on, just for laughs.' },
    { n: 1, label: 'Week 1', start: '2026-11-01', end: '2026-11-07', note: 'The awkward stubble phase.' },
    { n: 2, label: 'Week 2', start: '2026-11-08', end: '2026-11-14', note: 'Commit to the bit.' },
    { n: 3, label: 'Week 3', start: '2026-11-15', end: '2026-11-21', note: 'It is starting to look intentional.' },
    { n: 4, label: 'Final Mo', start: '2026-11-22', end: '2026-11-30', note: 'Full glory. Nine days to peak.' },
  ],
};
