# Mo + Mileage

A free, public Movember competition site: grow a mo, log kilometres, vote on mustaches, and push everyone toward the team donation page.

- **Standings:** Overall, Kilometres, Mustache
- **Log km:** any movement, with distance, moving time and required proof (Strava link or screenshot)
- **Mustaches:** Shave-Down photo, then one photo a week, 3 votes per person per round
- **Feed:** every entry with its proof, and a "Question this" button
- **Review page (organizer):** paused entries, plus a weekly check against the Strava group challenge

Everything runs on free tiers: GitHub Pages (website), Supabase (database, photos, email sign-in) and Brevo (sends the sign-in emails). Total cost: $0.

Donations never touch this site. They go to the Movember team page: https://movember.com/t/mo-mileage

---

## Launch in about 30 minutes

### 1. Database (Supabase) — 10 min
1. Go to supabase.com, sign up free, **New project**. Name it `mo-mileage`, pick region **Canada (Central)**, save the database password somewhere.
2. Open **SQL Editor > New query**, paste all of `supabase/schema.sql`, click **Run**. It should say "Success".
3. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `config.js`:
   ```js
   SUPABASE_URL: 'https://abcd1234.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...',
   ```
   The anon key is safe to publish. Never put the `service_role` key anywhere in this site.

### 2. Sign-in emails (Brevo) — 10 min. Do not skip this.
Supabase's built-in email only sends to your own team members, at about 2 per hour. With 100 people that breaks on day one.
1. Sign up free at brevo.com (300 emails a day). Under **Senders**, verify the email you want sign-in links to come from.
2. In Brevo, open **SMTP & API > SMTP**, generate an SMTP key. Note the server (`smtp-relay.brevo.com`), port `587`, and login.
3. In Supabase, **Authentication > Emails > SMTP Settings**: turn on custom SMTP and paste the Brevo host, port, login, SMTP key, and your verified sender. Sender name: `Mo + Mileage`.
4. **Authentication > Rate Limits**: raise "emails sent per hour" to about **150** for launch week.
5. **Authentication > Emails > Templates > Magic Link**: replace the body with this so people can use the code on a different device than the one with their email:
   ```html
   <h2>Your Mo + Mileage sign-in</h2>
   <p><a href="{{ .ConfirmationURL }}">Tap here to sign in</a></p>
   <p>Or enter this code on the site: <b>{{ .Token }}</b></p>
   ```
   Do the same for the **Confirm signup** template (first-time sign-ins use it).

### 3. Website (GitHub Pages) — 5 min
1. Sign up at github.com, click **New repository**, name it `mo-mileage`, set it **Public**, create it.
2. Click **uploading an existing file**, drag in everything from this folder (`index.html`, `app.js`, `config.js`, `styles.css`, `README.md`, and the `supabase` folder). Commit.
3. **Settings > Pages**: Source = **Deploy from a branch**, Branch = `main` / `root`. Save. After a minute your site is at `https://YOUR-USERNAME.github.io/mo-mileage/`.
4. Back in Supabase, **Authentication > URL Configuration**: set **Site URL** to that address and add it under **Redirect URLs**.

### 4. Make yourself the organizer — 2 min
1. Open the site, click **Join**, sign in with your email, and create your profile.
2. In Supabase **SQL Editor**, run (with your email):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
3. Refresh the site. A **Review** button appears in the header, and Remove/Hide buttons appear on the Feed and Mustaches pages.

### 5. Strava group challenge (your Premium account) — 5 min
This is the anti-cheat backstop for everyone on Strava.
1. In the Strava mobile app, open **Groups**, go to **Challenges** and create a group challenge. Strava moves this menu around between app versions, so search its help centre for "group challenge" if it is not there.
2. Type: **Most activity**, goal **distance**, dates **Nov 1 to Nov 30**, sports: Run, Walk, Hike, Wheelchair, Ride, Swim. Name it `Mo + Mileage`.
3. Turn on **Allow participants to invite others**, then invite people. You can invite up to 199 people who follow you; invitees can invite their own followers.
4. Copy the challenge invite link into `STRAVA_CHALLENGE_URL` in `config.js`.
5. Once a week, open the challenge leaderboard on Strava and type each person's distance into the **Strava check** table on the Review page. Matching people get a "Strava checked" tag; anyone whose site total runs higher shows up in red.

Strava says each invitee needs a subscription, a free trial, or a free challenge left, so some free users may not be able to join. They still compete on the site with screenshots as proof.

### 6. Optional extras
- **Strava Club:** free, unlimited members, shared feed and kudos. Paste its link into `STRAVA_CLUB_URL`.
- **Your contact:** fill in `ORGANIZER_EMAIL` in `config.js`.
- **Custom domain:** buy one (e.g. momileage.ca, about $15/yr) and add it under GitHub **Settings > Pages**. Then update the Supabase Site URL.

To change anything on the site later, edit the file on GitHub (pencil icon) and commit. Changes go live in about a minute.

---

## How the rules are enforced

All rules live in the database, so nobody can get around them from their browser:

| Rule | Where |
|---|---|
| Every entry needs proof: a Strava link or a screenshot | `proof_required` check |
| The same Strava activity (any link format) can only be logged once, by anyone | normalized link + unique index |
| The same screenshot file can only be used once, by anyone | SHA-256 fingerprint + unique index |
| Faster than a believable pace pauses the entry for review (run 2:45/km, walk 6:30/km, bike 50 km/h, swim 1:00/100 m) | `min_pace()` in `activities_guard` |
| Three "Question this" flags from different people pause an entry; once you approve it, flags cannot re-pause it | `flags_after` trigger |
| Paused or removed entries do not count anywhere | all views |
| Activities only dated Nov 1 to 30, never in the future | `activities_guard` trigger |
| Max 100 km per entry (300 bike, 15 swim), max 10 entries a day | `activities_guard` |
| Logging and voting close end of day Dec 2 | `grace_open()` |
| One mo photo per person per week, week set by the server clock | `mo_photos_guard` + unique key |
| 3 votes per week, no voting for yourself, no voting on Shave-Down | `votes_guard` |
| Nobody can edit their km after posting (delete and re-log instead) | column privileges |
| Only admins can hide entries, change the raised total, or see admin list | row-level security |
| Photos and screenshots can only be uploaded into your own folder, 6 MB, images only | storage policies |

Points per km: run, walk, hike, wheelchair ×1; bike ×0.33; swim ×4.
Overall score: 50 × (your points / leader's points) + 50 × (your votes / leader's votes).

To change dates, multipliers or caps, edit `supabase/schema.sql` (functions `mo_week`, `kind_multiplier`, `activities_guard`) and the matching `WEEKS` in `config.js`, then re-run only the functions you changed. **Do not re-run the whole file after launch: its first block deletes all data.**

## Moderation
- **Review page:** approve or remove paused entries. Flag notes are visible only to you, never to the person flagged.
- Remove a suspicious activity from the Feed, or hide a photo on the Mustaches page. Both stop counting immediately.
- To unhide: Supabase **Table Editor > activities** (or `mo_photos`), set `hidden` to false.
- To remove a person entirely: Supabase **Authentication > Users > Delete user**. Their profile, km, photos and votes go with them.

## Privacy note for participants
Names, towns, km, moving times, notes, proof links, proof screenshots and mustache photos are public on the site. If you join the Strava group challenge, the organizer copies your challenge distance into the site's check table (only the pass/fail tag is public). Email addresses are never shown. Put this in your invite so nobody is surprised.
