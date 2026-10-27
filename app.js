import { CONFIG } from './config.js';

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
const CONFIGURED = !/YOUR-/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
let sb = null;
if (CONFIGURED) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
}

const S = { session: null, profile: null, isAdmin: false, ready: false };
const $app = document.getElementById('app');
const GOAL = CONFIG.GOAL_KM_EACH;

// Must match kind_multiplier(), min_pace() and the caps in schema.sql
const KINDS = {
  run:        { label: 'Run',        verb: 'ran',    mult: 1,    minPace: 2.75, cap: 100 },
  walk:       { label: 'Walk',       verb: 'walked', mult: 1,    minPace: 6.5,  cap: 100 },
  hike:       { label: 'Hike',       verb: 'hiked',  mult: 1,    minPace: 6.5,  cap: 100 },
  wheelchair: { label: 'Wheelchair', verb: 'rolled', mult: 1,    minPace: 2.0,  cap: 100 },
  cycle:      { label: 'Bike ride',  verb: 'rode',   mult: 0.33, minPace: 1.2,  cap: 300 },
  swim:       { label: 'Swim',       verb: 'swam',   mult: 4,    minPace: 10,   cap: 15 },
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => Number(n || 0).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const first = (name) => (name || '').split(' ')[0];

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function currentWeek() {
  const t = today(), W = CONFIG.WEEKS;
  if (t < W[1].start) return 0;
  if (t > W[W.length - 1].end) return null;
  return W.find((w) => t >= w.start && t <= w.end)?.n ?? null;
}
const challengeLive = () => today() >= CONFIG.WEEKS[1].start;
const graceOpen = () => today() <= '2026-12-02';
const daysLeft = () => {
  const end = new Date('2026-11-30T23:59:59-05:00').getTime();
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000));
};

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}
const prettyDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
function duration(min) {
  const m = Math.round(Number(min));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
function pace(min, km) {
  const p = min / km; const mm = Math.floor(p); const ss = Math.round((p - mm) * 60);
  return `${mm}:${String(ss === 60 ? 0 : ss).padStart(2, '0')}/km`;
}

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 6000 : 3000);
}

function friendlyError(e) {
  const m = e?.message || String(e);
  if (/proof_url_once/.test(m)) return 'That Strava activity has already been logged. Each activity counts once.';
  if (/proof_hash_once/.test(m)) return 'That exact screenshot has already been used. Upload the screenshot for this activity.';
  if (/proof_required/.test(m)) return 'Add a Strava link or a screenshot as proof.';
  if (/mo_space_url/.test(m)) return 'Your Mo Space link must start with https:// and be on movember.com.';
  if (/strava_url/.test(m)) return 'Your Strava link must start with https://www.strava.com/';
  if (/display_name/.test(m)) return 'Your name must be 2 to 40 characters.';
  if (/proof_url/.test(m)) return 'The proof link must start with https://';
  if (/duration_min/.test(m)) return 'Add how long the activity took.';
  if (/activity_date/.test(m)) return 'The date must be in November 2026.';
  if (/mo_photos_user_id_week_key/.test(m)) return 'You already posted a mo this week. Delete it to post a new one.';
  if (/activity_flags_pkey/.test(m)) return 'You already questioned this entry.';
  if (/votes_pkey/.test(m)) return 'You already voted for that mo.';
  if (/Error sending .*email/i.test(m)) return 'The email service rejected the message. The organizer needs to check the email settings.';
  if (/rate limit/i.test(m)) return 'Too many sign-in emails were sent recently. Wait a few minutes and try again.';
  if (/security purposes.*after (\d+) seconds/i.test(m)) return `Wait ${m.match(/after (\d+) seconds/i)[1]} seconds before asking for another email.`;
  if (/row-level security/.test(m)) return 'Sign in to do that.';
  if (/JWT|token/i.test(m)) return 'Your sign-in expired. Sign in again.';
  return m;
}

function photoUrl(path, bucket = 'mo-photos') {
  if (!path) return '';
  if (!sb || /^data:|^https?:/.test(path)) return path;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Use a JPEG or PNG.')); };
    img.src = url;
  });
}
async function compress(file, max = 1600, square = false) {
  const { img, url } = await loadImage(file);
  const c = document.createElement('canvas');
  if (square) {
    // Centre-crop to a square, then shrink: profile photos look right in a circle.
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.width = c.height = Math.min(max, side);
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, c.width, c.height);
  } else {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  }
  URL.revokeObjectURL(url);
  return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}
// Fingerprint of the original file, so the same screenshot cannot be reused.
async function sha256(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function uploadImage(bucket, file, max = 1600, square = false) {
  const blob = await compress(file, max, square);
  const path = `${S.session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}

const face = (row) => row.photo_path
  ? `<img class="face" src="${esc(photoUrl(row.photo_path))}" alt="" loading="lazy">`
  : `<div class="face" aria-hidden="true">${esc(initials(row.display_name))}</div>`;
const loading = () => '<p class="loading">Loading…</p>';

// ---------------------------------------------------------------------
// Demo data, shown until Supabase is connected
// ---------------------------------------------------------------------
const DEMO = (() => {
  const rows = [['Noah W.', 'Ottawa', 88.4, 14, true], ['Jordan K.', 'Fredericton', 71.2, 11, true], ['Priya S.', 'Ottawa', 64.0, 3, false],
    ['Mike T.', 'Kanata', 52.5, 17, true], ['Sam L.', 'Toronto', 40.1, 6, false], ['Dave R.', 'Halifax', 33.0, 9, true], ['Alex M.', 'Gatineau', 18.6, 2, false], ['Chris B.', 'Moncton', 9.2, 5, false]];
  const tones = ['#2440c8', '#000', '#5b6168', '#2440c8', '#000', '#5b6168', '#2440c8', '#000'];
  const moSvg = (i, n) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#e4e6e1"/><circle cx="100" cy="96" r="62" fill="#e9cdb4"/><circle cx="78" cy="82" r="6" fill="#000"/><circle cx="122" cy="82" r="6" fill="#000"/><path d="M44 116c14 ${8 + n} 36 6 50-6 4 3 8 3 12 0 14 12 36 ${14 + n} 50 6-6 18-30 26-52 12-4-2-8-2-12 0-22 14-46 6-48-12z" fill="${tones[i]}"/><text x="100" y="190" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#474c52">sample</text></svg>`);
  const lb = rows.map(([n, h, km, v, chk], i) => ({ user_id: 'd' + i, display_name: n, hometown: h, km_points: km, raw_km: km, mo_votes: v, strava_checked: chk, photo_path: moSvg(i, v), mo_space_url: CONFIG.MOVEMBER_TEAM_URL, is_participant: true }));
  const maxK = Math.max(...lb.map((r) => r.km_points)), maxV = Math.max(...lb.map((r) => r.mo_votes));
  lb.forEach((r) => (r.moathlete_score = Math.round((50 * r.km_points / maxK + 50 * r.mo_votes / maxV) * 10) / 10));
  const kinds = ['run', 'walk', 'cycle', 'hike', 'run', 'swim', 'walk', 'run'];
  const feed = lb.map((r, i) => ({ id: i, user_id: r.user_id, display_name: r.display_name, kind: kinds[i], distance_km: [10, 6.2, 32, 8, 5, 1.5, 4, 12][i],
    duration_min: [52, 70, 85, 110, 27, 38, 45, 64][i], points: [10, 6.2, 10.6, 8, 5, 6, 4, 12][i], activity_date: '2026-11-0' + (i % 7 + 1),
    created_at: new Date(Date.now() - i * 5400000).toISOString(), under_review: i === 4,
    note: ['Frozen canal loop', 'Lunch walk', '', 'Gatineau Park', 'Treadmill, it was sleeting', '', 'Walked the dog twice', 'Long run'][i],
    proof_url: i % 2 ? '' : 'https://www.strava.com/', proof_path: i % 2 ? 'data:,' : '' }));
  const gallery = lb.map((r, i) => ({ id: i, user_id: r.user_id, display_name: r.display_name, week: 1, storage_path: r.photo_path,
    caption: ['Day 7. Itchy.', 'Pencil-thin and proud', '', 'The Selleck starter kit', '', 'Patchy but persistent', '', 'Mo or shadow?'][i], votes: r.mo_votes, created_at: new Date().toISOString() }));
  const bios = ['Running for my dad. Shaving on December 1, not a day before.', 'Canal loops at 6am. Send coffee.', '', 'Trail guy. The mo is a work in progress.', '', '', '', ''];
  lb.forEach((r, i) => (r.bio = bios[i]));
  return { lb, feed, gallery, totals: { participants: 8, total_km: lb.reduce((a, r) => a + r.raw_km, 0), hit_60: 3, mo_photos: 8 },
    settings: { raised_amount: 1240, goal_amount: 2500, announcement: '' } };
})();

// ---------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
const api = {
  settings: () => (sb ? q(sb.from('site_settings').select('*').eq('id', 1).single()) : DEMO.settings),
  totals: () => (sb ? q(sb.from('team_totals').select('*').single()) : DEMO.totals),
  leaderboard: () => (sb ? q(sb.from('leaderboard').select('*')) : DEMO.lb),
  feed: () => (sb ? q(sb.from('activity_feed').select('*').order('created_at', { ascending: false }).limit(100)) : DEMO.feed),
  gallery: (week) => (sb ? q(sb.from('mo_gallery').select('*').eq('week', week).order('created_at', { ascending: false })) : DEMO.gallery.map((g) => ({ ...g, week }))),
  myVotes: () => (sb && S.session ? q(sb.from('votes').select('photo_id, week')) : []),
  myFlags: () => (sb && S.session ? q(sb.from('activity_flags').select('activity_id').eq('flagger_id', S.session.user.id)) : []),
  myActivities: () => (sb && S.session ? q(sb.from('activities').select('*').eq('user_id', S.session.user.id).order('activity_date', { ascending: false })) : []),
};

async function loadUser() {
  if (!sb) { S.ready = true; return; }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  S.profile = null; S.isAdmin = false;
  if (S.session) {
    const { data: p } = await sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle();
    S.profile = p;
    const { data: a } = await sb.rpc('is_admin');
    S.isAdmin = !!a;
  }
  S.ready = true;
}

// ---------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------
function renderChrome(route) {
  document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  const act = document.getElementById('top-actions');
  act.innerHTML = S.session && S.profile
    ? `${S.isAdmin ? '<a class="btn sm line" href="#/review">Review</a>' : ''}<a class="btn sm hivis" href="#/log">Log km</a><a class="btn sm line" href="#/me">${esc(first(S.profile.display_name))}</a>`
    : `<a class="btn sm line" href="${esc(CONFIG.DONATE_URL)}" target="_blank" rel="noopener">Donate</a><a class="btn sm hivis" href="#/join">Join</a>`;
  document.getElementById('banner').innerHTML = CONFIGURED ? '' :
    '<div class="demo-banner">Preview with sample people. Add your Supabase keys in <code>config.js</code> to go live.</div>';
  document.getElementById('foot-team').href = CONFIG.MOVEMBER_TEAM_URL;
}

function needAuth(what) {
  if (!CONFIGURED) {
    $app.innerHTML = `<div class="sheet"><h2>Not live yet</h2><p>${esc(what)} works once the site is connected to its database. The README has the setup steps.</p><a class="btn" href="#/">Back to standings</a></div>`;
    return true;
  }
  if (!S.session || !S.profile) { location.hash = '#/join'; return true; }
  return false;
}

// ---------------------------------------------------------------------
// Standings (home)
// ---------------------------------------------------------------------
let boardTab = 'combo';
let boardFilter = '';

async function pageHome() {
  $app.innerHTML = loading();
  const [settings, totals, lb] = await Promise.all([api.settings(), api.totals(), api.leaderboard()]);
  const pct = Math.min(100, (100 * settings.raised_amount) / Math.max(1, settings.goal_amount));
  const signedIn = S.session && S.profile;
  const live = challengeLive();

  $app.innerHTML = `
    <section class="start">
      <div class="bib" role="img" aria-label="Race bib reading 60: kilometres each, one mustache, all of November">
        <i class="pin tl"></i><i class="pin tr"></i><i class="pin bl"></i><i class="pin br"></i>
        <div class="bib-band"><span>Mo + Mileage</span><span>Nov 2026</span></div>
        <div class="bib-number">60</div>
        <div class="bib-line">kilometres each. one mustache. all of November.</div>
        <div class="bib-tear">
          <div><b>${esc(totals.participants)}</b>signed up</div>
          <div><b>${esc(fmt(totals.total_km, 0))}</b>team km</div>
          <div><b>${live ? esc(daysLeft()) : esc(totals.hit_60)}</b>${live ? 'days left' : 'at 60 km'}</div>
        </div>
      </div>
      <div class="start-copy">
        <p>Movember asks for 60 km in November, one for each of the 60 men the world loses to suicide every hour. Sixty is where you start counting, not where you stop. We are doing it with mustaches, a scoreboard and a lot of cold mornings.</p>
        <div class="actions">
          ${signedIn ? '<a class="btn primary" href="#/log">Log your km</a>' : '<a class="btn primary" href="#/join">Sign up</a>'}
          <a class="btn line" href="${esc(CONFIG.DONATE_URL)}" target="_blank" rel="noopener">Donate to the team</a>
        </div>
        <div class="raised">
          <div><b class="fig" style="font-size:30px">${money(settings.raised_amount)}</b> <span class="muted">raised of ${money(settings.goal_amount)}</span></div>
          <div class="meter"><i style="width:${pct}%"></i></div>
        </div>
      </div>
    </section>
    ${settings.announcement ? `<p class="notice">${esc(settings.announcement)}</p>` : ''}
    <section class="block">
      <div class="head">
        <h2>Standings</h2>
        <div class="seg" role="tablist">
          <button data-tab="combo">Overall</button><button data-tab="km">Kilometres</button><button data-tab="mo">Mustache</button>
        </div>
      </div>
      <input id="lb-filter" class="search" type="search" placeholder="Find a name or town" aria-label="Find a name or town" value="${esc(boardFilter)}">
      <p class="small muted" id="board-note" style="margin:12px 0 14px"></p>
      <ol class="standings" id="board"></ol>
    </section>`;

  const draw = () => {
    document.querySelectorAll('[data-tab]').forEach((t) => { t.classList.toggle('on', t.dataset.tab === boardTab); t.setAttribute('aria-selected', t.dataset.tab === boardTab); });
    const key = { combo: 'moathlete_score', km: 'km_points', mo: 'mo_votes' }[boardTab];
    const sorted = [...lb].sort((a, b) => Number(b[key]) - Number(a[key]) || a.display_name.localeCompare(b.display_name));
    sorted.forEach((r, i) => (r._pos = i + 1));
    const scale = Math.max(GOAL, ...lb.map((r) => Number(r.km_points)));
    const f = boardFilter.trim().toLowerCase();
    const rows = sorted.filter((r) => !f || `${r.display_name} ${r.hometown || ''}`.toLowerCase().includes(f)).slice(0, 250);
    document.getElementById('board').innerHTML = rows.length ? rows.map((r) => {
      const km = Number(r.km_points);
      const [v, unit] = boardTab === 'combo' ? [fmt(r.moathlete_score), 'points'] : boardTab === 'km' ? [fmt(km), 'km'] : [r.mo_votes, r.mo_votes == 1 ? 'vote' : 'votes'];
      const mine = S.session && r.user_id === S.session.user.id;
      return `<li class="${mine ? 'me' : ''}">
        <div class="pos">${r._pos}</div>${face(r)}
        <div class="who"><a class="nm" href="#/p/${esc(r.user_id)}">${esc(r.display_name)}</a>
          <div class="meta">${r.hometown ? `<span>${esc(r.hometown)}</span>` : ''}
            ${km >= 200 ? '<span class="tag done">200 club</span>' : km >= 100 ? '<span class="tag done">100 club</span>' : km >= GOAL ? '<span class="tag done">60 done</span>' : ''}
            ${r.strava_checked ? '<span class="tag checked" title="Organizer matched this total to the Strava challenge">Strava checked</span>' : ''}
            ${r.mo_space_url ? `<a href="${esc(r.mo_space_url)}" target="_blank" rel="noopener">Sponsor ${esc(first(r.display_name))}</a>` : ''}</div>
          ${boardTab !== 'mo' ? `<div class="road" aria-label="${fmt(km)} of ${GOAL} km"><i style="width:${(100 * km) / scale}%"></i><s style="left:${(100 * GOAL) / scale}%"></s></div>` : ''}</div>
        <div class="val"><b>${esc(v)}</b><span>${unit}</span></div></li>`;
    }).join('') : `<li class="blank" style="display:block">${lb.length ? 'Nobody by that name yet.' : 'Nobody has signed up yet. The first name on the board could be yours.'}</li>`;
    document.getElementById('board-note').textContent = {
      combo: 'Overall: up to 50 points for kilometres and up to 50 for mustache votes, each measured against the current leader. You need both to win it.',
      km: `Kilometres with activity multipliers. The blue mark on each line is ${GOAL} km.`,
      mo: 'Votes received across the four weekly mustache rounds.',
    }[boardTab];
  };
  document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { boardTab = t.dataset.tab; draw(); }));
  document.getElementById('lb-filter').addEventListener('input', (e) => { boardFilter = e.target.value; draw(); });
  draw();
}

// ---------------------------------------------------------------------
// Log km
// ---------------------------------------------------------------------
async function pageLog() {
  if (needAuth('Logging kilometres')) return;
  $app.innerHTML = loading();
  const mine = await api.myActivities();
  const t = today();
  const maxDate = t < '2026-11-30' ? t : '2026-11-30';
  const live = challengeLive(), open = graceOpen();
  const counted = mine.filter((a) => !a.hidden && !a.under_review);
  const total = counted.reduce((s, a) => s + a.distance_km * KINDS[a.kind].mult, 0);

  $app.innerHTML = `
    <div class="sheet">
      <h2>Log kilometres</h2>
      <div><span class="tally">${fmt(total)}</span> <span class="muted">of ${GOAL} km counted so far</span></div>
      ${!live ? `<div class="panel"><h3>Logging opens November 1</h3><p>Until then, post your clean-shaven <a href="#/mo">Shave-Down photo</a>.</p></div>`
      : !open ? `<div class="panel"><h3>Logging is closed</h3><p>Final results are on the standings page. Thank you for moving.</p></div>` : `
      <form class="panel" id="log-form" novalidate>
        <div class="pair">
          <div><label for="kind">Activity</label><select id="kind">
            ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v.label}${v.mult !== 1 ? ` (counts ×${v.mult})` : ''}</option>`).join('')}</select></div>
          <div><label for="date">Date</label><input id="date" type="date" min="2026-11-01" max="${maxDate}" value="${maxDate}"></div>
        </div>
        <label for="km">Distance in km</label>
        <input id="km" type="number" inputmode="decimal" step="0.01" min="0.1" placeholder="5.0">
        <div class="hint">Strava set to miles? Multiply by 1.609.</div>
        <label for="hrs">Moving time</label>
        <div class="pair keep">
          <div><input id="hrs" type="number" inputmode="numeric" min="0" max="23" placeholder="0" aria-label="Hours"><div class="hint">hours</div></div>
          <div><input id="mins" type="number" inputmode="numeric" min="0" max="59" placeholder="45" aria-label="Minutes"><div class="hint">minutes</div></div>
        </div>
        <div class="pace" id="pace"></div>
        <label for="proof">Proof: Strava activity link</label>
        <input id="proof" type="url" placeholder="https://www.strava.com/activities/…">
        <label for="shot">or a screenshot from any app <span class="opt">(Garmin, Apple Health, treadmill screen)</span></label>
        <input id="shot" type="file" accept="image/*">
        <div class="hint">One of the two is required. Each Strava activity and each screenshot can only be logged once.</div>
        <label for="note">Note <span class="opt">(optional, shows in the feed)</span></label>
        <input id="note" maxlength="140" placeholder="Frozen canal, zero regrets">
        <button class="btn primary block" style="margin-top:22px" id="log-btn">Add to my total</button>
        ${CONFIG.STRAVA_CHALLENGE_URL ? `<p class="hint" style="margin-top:14px">On Strava? <a href="${esc(CONFIG.STRAVA_CHALLENGE_URL)}" target="_blank" rel="noopener">Join the Strava group challenge</a> too, so the organizer can confirm your total.</p>` : ''}
      </form>`}
      <div class="panel"><h3>My entries</h3>
        ${mine.length ? `<ul class="log">${mine.map((a) => `<li>
          <div class="km">${fmt(a.distance_km)}<small>km</small></div>
          <div class="what"><b>${esc(KINDS[a.kind].label)}</b>, ${prettyDate(a.activity_date)}, ${duration(a.duration_min)}
            ${a.under_review ? `<div><span class="tag review">Being checked</span> <span class="small muted">${esc(a.review_reason || '')}. Not counted until the organizer clears it.</span></div>` : ''}
            ${a.hidden ? '<div><span class="tag review">Removed by organizer</span></div>' : ''}
            ${a.note ? `<div class="small muted">${esc(a.note)}</div>` : ''}</div>
          <div class="side">${open ? `<button class="linkbtn" data-del="${a.id}">Delete</button>` : ''}</div></li>`).join('')}</ul>`
          : '<p class="muted">Nothing logged yet.</p>'}
      </div>
    </div>`;

  const form = document.getElementById('log-form');
  if (form) {
    const read = () => {
      const kind = form.kind.value, km = parseFloat(form.km.value);
      const min = (parseInt(form.hrs.value || '0', 10) * 60) + parseInt(form.mins.value || '0', 10);
      return { kind, km, min };
    };
    const upd = () => {
      const { kind, km, min } = read();
      const el = document.getElementById('pace');
      if (!(km > 0) || !(min > 0)) { el.innerHTML = ''; return; }
      const K = KINDS[kind];
      const pts = K.mult !== 1 ? ` Counts as ${fmt(km * K.mult)} km.` : '';
      el.innerHTML = min / km < K.minPace
        ? `<div class="warn">${pace(min, km)} is faster than our pace check for a ${esc(K.label.toLowerCase())}. It will be saved but not counted until the organizer looks at it. Double-check the distance and time.</div>`
        : `Pace ${pace(min, km)}.${pts}`;
    };
    ['kind', 'km', 'hrs', 'mins'].forEach((id) => form[id].addEventListener('input', upd));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { kind, km, min } = read();
      const K = KINDS[kind];
      const proof = form.proof.value.trim();
      const file = form.shot.files[0];
      if (!(km > 0)) return toast('Enter the distance in km.', true);
      if (km > K.cap) return toast(`One ${K.label.toLowerCase()} can be at most ${K.cap} km. Log separate days separately.`, true);
      if (!(min > 0)) return toast('Enter how long it took.', true);
      if (!proof && !file) return toast('Add a Strava link or a screenshot as proof.', true);
      if (proof && !/^https:\/\//i.test(proof)) return toast('The proof link must start with https://', true);
      const btn = document.getElementById('log-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        let proof_path = null, proof_hash = null;
        if (file) { proof_hash = await sha256(file); proof_path = await uploadImage('proof', file); }
        const [row] = await q(sb.from('activities').insert({ kind, activity_date: form.date.value, distance_km: km, duration_min: min,
          proof_url: proof || null, proof_path, proof_hash, note: form.note.value.trim() || null }).select());
        toast(row?.under_review ? 'Saved. It goes to the organizer for a quick check before it counts.' : `${fmt(km, 2)} km added.`);
        pageLog();
      } catch (err) {
        toast(friendlyError(err), true);
        btn.disabled = false; btn.textContent = 'Add to my total';
      }
    });
  }
  $app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this entry?')) return;
    try { await q(sb.from('activities').delete().eq('id', b.dataset.del)); toast('Entry deleted.'); pageLog(); }
    catch (err) { toast(friendlyError(err), true); }
  }));
}

// ---------------------------------------------------------------------
// Mustaches
// ---------------------------------------------------------------------
let moWeek = null;
let moSort = 'new';
async function pageMo() {
  const cw = currentWeek();
  if (moWeek === null) moWeek = cw ?? CONFIG.WEEKS[CONFIG.WEEKS.length - 1].n;
  const W = CONFIG.WEEKS.find((w) => w.n === moWeek);
  $app.innerHTML = loading();
  const [photos, votes] = await Promise.all([api.gallery(moWeek), api.myVotes()]);
  const myVoteIds = new Set(votes.map((v) => v.photo_id));
  const used = votes.filter((v) => v.week === moWeek).length;
  const uid = S.session?.user.id;
  const mine = photos.find((p) => p.user_id === uid);
  const canPost = CONFIGURED && S.profile?.is_participant && cw === moWeek && !mine;
  const canVote = CONFIGURED && S.profile && moWeek > 0 && graceOpen();
  const sorted = [...photos].sort((a, b) => (moSort === 'top' ? b.votes - a.votes : 0) || new Date(b.created_at) - new Date(a.created_at));

  $app.innerHTML = `
    <section class="block">
      <div class="head"><h2>Mustaches</h2>
        <div class="seg">${CONFIG.WEEKS.map((w) => `<button class="${w.n === moWeek ? 'on' : ''}" data-week="${w.n}">${esc(w.label)}</button>`).join('')}</div></div>
      <p>${esc(W.note)} ${prettyDate(W.start)} to ${prettyDate(W.end)}.${moWeek > 0 ? ' Everyone signed in gets 3 votes for this round and cannot vote for themselves.' : ''}</p>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:0 0 22px">
        ${canVote ? `<b>${3 - used} of 3 votes left this round</b>` : ''}
        ${moWeek > 0 && photos.length > 1 ? `<button class="linkbtn" id="mo-sort">${moSort === 'top' ? 'Show newest first' : 'Show most votes first'}</button>` : ''}
        ${!S.session && CONFIGURED ? '<span><a href="#/join">Sign in</a> to post and vote. Friends and family can sign up just to vote.</span>' : ''}
      </div>
      <div class="mos">
        ${canPost ? `<form class="post" id="mo-form">
          <h3>Post your ${esc(W.label.toLowerCase())} photo</h3>
          <p class="small">Face the camera, decent light, no filters.</p>
          <input type="file" id="mo-file" accept="image/*" aria-label="Mustache photo">
          <img id="mo-prev" class="thumb" alt="" hidden>
          <input id="mo-cap" maxlength="80" placeholder="Caption (optional)" style="margin-top:10px" aria-label="Caption">
          <button class="btn primary block" style="margin-top:12px" id="mo-btn">Post photo</button></form>` : ''}
        ${sorted.map((p) => {
          const own = p.user_id === uid, voted = myVoteIds.has(p.id);
          return `<figure class="mo" style="margin:0"><img src="${esc(photoUrl(p.storage_path))}" alt="${esc(p.display_name)}'s mustache" loading="lazy">
            <div class="row"><div><a class="nm" href="#/p/${esc(p.user_id)}">${esc(p.display_name)}</a>${moWeek > 0 ? `<div class="small muted">${p.votes} vote${p.votes == 1 ? '' : 's'}</div>` : ''}</div>
              ${own ? `<button class="btn sm line" data-delphoto="${p.id}" data-path="${esc(p.storage_path)}">Delete</button>`
                : canVote ? `<button class="btn sm vote${voted ? ' on' : ''}" data-vote="${p.id}" ${!voted && used >= 3 ? 'disabled' : ''} aria-pressed="${voted}">${voted ? 'Voted' : 'Vote'}</button>` : ''}
              ${S.isAdmin && !own ? `<button class="linkbtn" data-hidephoto="${p.id}">Hide</button>` : ''}</div>
            ${p.caption ? `<figcaption class="cap">${esc(p.caption)}</figcaption>` : ''}</figure>`;
        }).join('')}
      </div>
      ${!photos.length && !canPost ? `<p class="blank">No photos in ${esc(W.label.toLowerCase())} yet.</p>` : ''}
    </section>`;

  $app.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => { moWeek = Number(b.dataset.week); pageMo(); }));
  document.getElementById('mo-sort')?.addEventListener('click', () => { moSort = moSort === 'top' ? 'new' : 'top'; pageMo(); });
  const form = document.getElementById('mo-form');
  if (form) {
    const file = document.getElementById('mo-file');
    file.addEventListener('change', () => {
      const prev = document.getElementById('mo-prev');
      if (file.files[0]) { prev.src = URL.createObjectURL(file.files[0]); prev.hidden = false; }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!file.files[0]) return toast('Choose a photo first.', true);
      const btn = document.getElementById('mo-btn');
      btn.disabled = true; btn.textContent = 'Posting…';
      try {
        const path = await uploadImage('mo-photos', file.files[0]);
        await q(sb.from('mo_photos').insert({ storage_path: path, caption: document.getElementById('mo-cap').value.trim() || null }));
        toast('Photo posted.');
        pageMo();
      } catch (err) { toast(friendlyError(err), true); btn.disabled = false; btn.textContent = 'Post photo'; }
    });
  }
  $app.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.vote);
    b.disabled = true;
    try {
      if (myVoteIds.has(id)) await q(sb.from('votes').delete().eq('photo_id', id).eq('voter_id', uid));
      else await q(sb.from('votes').insert({ photo_id: id }));
      pageMo();
    } catch (err) { toast(friendlyError(err), true); b.disabled = false; }
  }));
  $app.querySelectorAll('[data-delphoto]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete your photo? Its votes are lost.')) return;
    try {
      await q(sb.from('mo_photos').delete().eq('id', b.dataset.delphoto));
      await sb.storage.from('mo-photos').remove([b.dataset.path]);
      toast('Photo deleted.'); pageMo();
    } catch (err) { toast(friendlyError(err), true); }
  }));
  $app.querySelectorAll('[data-hidephoto]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Hide this photo from everyone?')) return;
    try { await q(sb.from('mo_photos').update({ hidden: true }).eq('id', b.dataset.hidephoto)); toast('Photo hidden.'); pageMo(); }
    catch (err) { toast(friendlyError(err), true); }
  }));
}

// ---------------------------------------------------------------------
// Feed (with peer flagging)
// ---------------------------------------------------------------------
async function pageFeed() {
  $app.innerHTML = loading();
  const [feed, flags] = await Promise.all([api.feed(), api.myFlags()]);
  const flagged = new Set(flags.map((f) => f.activity_id));
  const uid = S.session?.user.id;
  const canFlag = CONFIGURED && S.profile && graceOpen();
  $app.innerHTML = `
    <section class="block">
      <div class="head"><h2>Feed</h2>
        ${CONFIG.STRAVA_CLUB_URL ? `<a class="btn sm line" href="${esc(CONFIG.STRAVA_CLUB_URL)}" target="_blank" rel="noopener">Strava club</a>` : ''}</div>
      <p>Every entry shows its proof. If something does not add up, question it. Three questions from different people pause the entry until the organizer checks it.</p>
      <ul class="log">
        ${feed.length ? feed.map((a) => {
          const K = KINDS[a.kind];
          return `<li>
            <div class="km">${fmt(a.distance_km)}<small>km</small></div>
            <div class="what">
              <div><a class="who-link" href="#/p/${esc(a.user_id)}">${esc(a.display_name)}</a> ${K.verb} ${fmt(a.distance_km)} km in ${duration(a.duration_min)}${K.mult !== 1 ? `, counts as ${fmt(a.points)}` : ''}
                ${a.under_review ? ' <span class="tag review">Being checked</span>' : ''}</div>
              ${a.note ? `<div>${esc(a.note)}</div>` : ''}
              <div class="links">
                ${a.proof_url ? `<a href="${esc(a.proof_url)}" target="_blank" rel="noopener nofollow">${/strava/i.test(a.proof_url) ? 'Strava activity' : 'Proof link'}</a>` : ''}
                ${a.proof_path ? `<a href="${esc(photoUrl(a.proof_path, 'proof'))}" target="_blank" rel="noopener">Screenshot</a>` : ''}
                <span class="when">${prettyDate(a.activity_date)}, posted ${timeAgo(a.created_at)}</span></div>
              <div id="ff-${a.id}"></div>
            </div>
            <div class="side">
              ${canFlag && a.user_id !== uid ? (flagged.has(a.id) ? '<span class="small muted">You questioned this</span>' : `<button class="linkbtn" data-flag="${a.id}">Question this</button>`) : ''}
              ${S.isAdmin ? `<button class="linkbtn" data-hide="${a.id}">Remove</button>` : ''}
            </div></li>`;
        }).join('') : '<li class="blank" style="display:block">No activities yet. The feed fills up on November 1.</li>'}
      </ul>
    </section>`;

  $app.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.flag;
    const box = document.getElementById('ff-' + id);
    box.innerHTML = `<form class="flagform"><input maxlength="140" placeholder="What looks off?" aria-label="What looks off?" required><button class="btn sm">Send</button></form>`;
    const f = box.querySelector('form');
    f.querySelector('input').focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await q(sb.from('activity_flags').insert({ activity_id: Number(id), reason: f.querySelector('input').value.trim() }));
        toast('Sent. The organizer can see your note; the person cannot.');
        pageFeed();
      } catch (err) { toast(friendlyError(err), true); }
    });
  }));
  $app.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this entry? It stops counting immediately.')) return;
    try { await q(sb.from('activities').update({ hidden: true }).eq('id', b.dataset.hide)); toast('Entry removed.'); pageFeed(); }
    catch (err) { toast(friendlyError(err), true); }
  }));
}

// ---------------------------------------------------------------------
// Organizer: review queue + Strava reconciliation
// ---------------------------------------------------------------------
async function pageReview() {
  if (needAuth('The review page')) return;
  if (!S.isAdmin) { location.hash = '#/'; return; }
  $app.innerHTML = loading();
  const [queue, lb, checks] = await Promise.all([
    q(sb.from('review_queue').select('*').order('created_at')),
    api.leaderboard(),
    q(sb.from('strava_checks').select('*')),
  ]);
  const byUser = Object.fromEntries(checks.map((c) => [c.user_id, c]));
  const people = [...lb].sort((a, b) => a.display_name.localeCompare(b.display_name));

  $app.innerHTML = `
    <section class="block">
      <h2>Review</h2>
      <h3 style="margin-top:24px">Paused entries (${queue.length})</h3>
      <p class="small muted">Entries that failed the pace check or were questioned by three people. They do not count until you approve them.</p>
      <ul class="log">${queue.length ? queue.map((a) => `<li>
        <div class="km">${fmt(a.distance_km)}<small>km</small></div>
        <div class="what"><b>${esc(a.display_name)}</b>, ${esc(KINDS[a.kind].label)}, ${duration(a.duration_min)} (${pace(a.duration_min, a.distance_km)}), ${prettyDate(a.activity_date)}
          <div class="small"><b>Why:</b> ${esc(a.review_reason || '')}${a.flag_reasons ? `. <b>Notes:</b> ${esc(a.flag_reasons)}` : ''}</div>
          ${a.note ? `<div class="small muted">${esc(a.note)}</div>` : ''}
          <div class="links">${a.proof_url ? `<a href="${esc(a.proof_url)}" target="_blank" rel="noopener">Proof link</a>` : ''}${a.proof_path ? `<a href="${esc(photoUrl(a.proof_path, 'proof'))}" target="_blank" rel="noopener">Screenshot</a>` : ''}</div></div>
        <div class="side"><button class="btn sm primary" data-ok="${a.id}">Approve</button><button class="btn sm line" data-no="${a.id}">Remove</button></div></li>`).join('')
        : '<li class="blank" style="display:block">Nothing waiting.</li>'}</ul>

      <h3 style="margin-top:40px">Strava check</h3>
      <p class="small muted">Once a week, open the Strava group challenge leaderboard and type each person's distance here. Anyone whose site total is within 5% (plus 1 km) of their Strava total gets a "Strava checked" tag. People not on Strava are checked through their screenshots instead.</p>
      <div class="scroll"><table class="recon">
        <thead><tr><th>Person</th><th>Site km (actual distance)</th><th>Strava km</th><th>Last checked</th><th>Result</th></tr></thead>
        <tbody>${people.map((p) => {
          const c = byUser[p.user_id];
          const diff = c ? Number(p.raw_km) - Number(c.strava_km) : null;
          const res = !c ? '<span class="muted">Not checked</span>' : p.strava_checked ? '<span class="good">Matches</span>' : `<span class="bad">Site is ${fmt(diff)} km higher</span>`;
          return `<tr><td>${esc(p.display_name)}</td><td>${fmt(p.raw_km)}</td>
            <td><input type="number" step="0.1" min="0" data-uid="${p.user_id}" value="${c ? esc(c.strava_km) : ''}" aria-label="Strava km for ${esc(p.display_name)}"></td>
            <td>${c ? prettyDate(c.checked_on) : ''}</td><td>${res}</td></tr>`;
        }).join('')}</tbody></table></div>
      <button class="btn primary" id="save-checks" style="margin-top:16px">Save Strava totals</button>
    </section>`;

  $app.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
    try { await q(sb.from('activities').update({ under_review: false, cleared: true }).eq('id', b.dataset.ok)); toast('Approved. It counts now.'); pageReview(); }
    catch (err) { toast(friendlyError(err), true); }
  }));
  $app.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this entry for good?')) return;
    try { await q(sb.from('activities').update({ hidden: true }).eq('id', b.dataset.no)); toast('Entry removed.'); pageReview(); }
    catch (err) { toast(friendlyError(err), true); }
  }));
  document.getElementById('save-checks').addEventListener('click', async () => {
    const rows = [...$app.querySelectorAll('[data-uid]')].filter((i) => i.value !== '')
      .map((i) => ({ user_id: i.dataset.uid, strava_km: Number(i.value), checked_on: today() }));
    try { if (rows.length) await q(sb.from('strava_checks').upsert(rows)); toast(`Saved ${rows.length} Strava totals.`); pageReview(); }
    catch (err) { toast(friendlyError(err), true); }
  });
}

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------
// The three-step joining sequence, shown on Rules and Sign up.
function joinSteps(onJoinPage = false) {
  return `
    <ol class="steps">
      <li><span class="n">1</span><div><h3>Join our Movember team <span class="opt-tag">Fundraising</span></h3>
        <p>Sign up on Movember and join the Mo + Mileage team. This is where the money goes, and it gives you your own Mo Space fundraising page.</p>
        <a class="btn primary" href="${esc(CONFIG.MOVEMBER_TEAM_URL)}" target="_blank" rel="noopener">Go to the Movember team</a></div></li>
      <li><span class="n">2</span><div><h3>Copy your Mo Space link <span class="opt-tag">Fundraising</span></h3>
        <p>Once you are in, open your Mo Space on movember.com and copy the web address from the address bar. It starts with https://ca.movember.com/ or https://movember.com/.</p></div></li>
      <li><span class="n">3</span><div><h3>Sign up here</h3>
        <p>Enter your email and pick your name for the standings. If you did steps 1 and 2, paste your Mo Space link and your name becomes a sponsor button.</p>
        ${S.session && S.profile ? '' : onJoinPage
          ? '<button class="btn" type="button" id="to-email">Enter my email</button>'
          : '<a class="btn" href="#/join">Sign up on this site</a>'}</div></li>
    </ol>`;
}

function pageRules() {
  $app.innerHTML = `
    <section class="block">
      <h2>Rules</h2>
      <p style="font-size:20px">November in Canada is dark at five and cold the rest of the time. This is a reason to get outside anyway, check in on each other, and raise money for men's mental health while doing it.</p>

      <h3 style="margin-top:40px">How to join</h3>
      <p>Fundraising is encouraged, never required. If you only want to move, grow a mustache and compete, skip straight to step 3. You are on the standings either way.</p>
      ${joinSteps()}

      <dl class="rulelist">
        <div><dt>Move</dt><dd>
          <p>Anything under your own power from November 1 to 30. Movember's target is ${GOAL} km. Treat that as the floor, not the finish line: the standings tag you at 60, 100 and 200 km.</p>
          <table class="mult">${Object.values(KINDS).map((k) => `<tr><td>${k.label}</td><td>×${k.mult}</td></tr>`).join('')}</table>
          <p class="small muted" style="margin-top:10px">A bike covers ground much faster than legs, and a kilometre in the pool is a lot of work. The multipliers keep everyone on one fair board.</p></dd></div>
        <div><dt>Mustache</dt><dd>
          <p>Start clean-shaven with a Shave-Down photo, then post one photo a week. Every signed-in person gets 3 votes a round and cannot vote for themselves. Cannot grow one? Draw it on. Commit to the bit.</p></dd></div>
        <div><dt>Scoreboards</dt><dd>
          <p><b>Kilometres:</b> total counted km. <b>Mustache:</b> total votes across the four weekly rounds. <b>Overall:</b> up to 50 points for each, measured against the leader of each board. You need both to win it.</p></dd></div>
        <div><dt>Keeping it honest</dt><dd>
          <p>Every entry needs proof: a Strava activity link or a screenshot from any app. Each Strava activity and each screenshot can only be used once. Entries faster than a believable pace, or questioned by three people, pause until the organizer checks them. On Strava? Join the group challenge too, and the organizer will match your total against it each week.</p>
          <p class="small muted">Max ${KINDS.run.cap} km per entry (${KINDS.cycle.cap} on a bike, ${KINDS.swim.cap} in the pool). Logging closes December 2. Questions go to ${esc(CONFIG.ORGANIZER_NAME)}${CONFIG.ORGANIZER_EMAIL ? ` at <a href="mailto:${esc(CONFIG.ORGANIZER_EMAIL)}">${esc(CONFIG.ORGANIZER_EMAIL)}</a>` : ''}.</p></dd></div>
        <div><dt>Look after each other</dt><dd>
          <p>Use the month as an excuse to check in on your people, and ask twice. If you or someone you know is struggling, call or text 9-8-8 (Canada's Suicide Crisis Helpline), any hour, any day.</p></dd></div>
      </dl>
    </section>`;
}

// ---------------------------------------------------------------------
// Sign up / profile
// ---------------------------------------------------------------------
async function pageJoin() {
  if (!CONFIGURED) return needAuth('Signing up');
  if (S.session && S.profile) { location.hash = '#/me'; return; }
  $app.innerHTML = `
    <div class="sheet">
      <h2>Sign up</h2>
      <p>Fundraising? Do steps 1 and 2 on Movember first, so you have your Mo Space link ready. Only here to move and compete, to vote and cheer, or already signed up? Go straight to step 3.</p>
      ${joinSteps(true)}
      <form class="panel" id="email-form">
        <p style="margin-top:0">No password. We email you a sign-in link and a 6-digit code.</p>
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required>
        <button class="btn primary block" style="margin-top:18px" id="email-btn">Email me a sign-in link</button>
        <p id="email-status" class="small" style="margin:12px 0 0" role="status"></p>
      </form>
      <form class="panel" id="code-form" hidden>
        <p>Check your inbox and spam folder. Tap the link, or type the code here. The code works on any device.</p>
        <label for="code">Code</label>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
        <button class="btn primary block" style="margin-top:18px">Sign in</button>
      </form>
    </div>`;
  let email = '';
  document.getElementById('to-email')?.addEventListener('click', () => {
    document.getElementById('email-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('email').focus({ preventScroll: true });
  });
  document.getElementById('email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('email-btn');
    email = document.getElementById('email').value.trim();
    btn.disabled = true; btn.textContent = 'Sending…';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false; btn.textContent = 'Send it again';
    const status = document.getElementById('email-status');
    if (error) {
      console.error('signInWithOtp', error);
      status.innerHTML = `<b style="color:var(--alert)">The email did not send.</b> ${esc(friendlyError(error))}${error.status ? ` (code ${esc(error.status)})` : ''}`;
      return;
    }
    status.textContent = `Sent to ${email}. It can take a minute. Check spam too.`;
    document.getElementById('code-form').hidden = false;
    toast('Sent. Check your inbox.');
  });
  document.getElementById('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.verifyOtp({ email, token: document.getElementById('code').value.trim(), type: 'email' });
    if (error) return toast(friendlyError(error), true);
    await loadUser(); route();
  });
}

function profileForm(isNew) {
  const p = S.profile || { is_participant: true };
  return `
    <form class="panel" id="profile-form">
      <h3>${isNew ? 'Last step: your name on the board' : 'Your profile'}</h3>
      <div class="avatar-edit">
        ${p.avatar_path ? `<img class="face lg" id="av-prev" src="${esc(photoUrl(p.avatar_path))}" alt="">` : `<div class="face lg" id="av-prev">${esc(initials(p.display_name || '?'))}</div>`}
        <div><label for="pa" style="margin-top:0">Profile photo <span class="opt">(optional)</span></label>
          <input id="pa" type="file" accept="image/*"><div class="hint">Cropped to a circle. Shows on the standings and your page.</div></div>
      </div>
      <label for="pn">Name</label>
      <input id="pn" maxlength="40" required value="${esc(p.display_name || '')}" placeholder="First name and last initial">
      <label for="ph">Town <span class="opt">(optional)</span></label>
      <input id="ph" maxlength="60" value="${esc(p.hometown || '')}" placeholder="Ottawa">
      <label for="pm">Your Movember Mo Space link <span class="opt">(optional, only if you are fundraising)</span></label>
      <input id="pm" type="url" value="${esc(p.mo_space_url || '')}" placeholder="https://movember.com/m/…">
      <div class="hint">Not fundraising? Leave it blank. Want to start? <a href="${esc(CONFIG.MOVEMBER_TEAM_URL)}" target="_blank" rel="noopener">Join our Movember team</a>, open your Mo Space and copy the address. You can add it later from the Me page.</div>
      <label for="pb">Bio <span class="opt">(optional, 280 characters)</span></label>
      <textarea id="pb" maxlength="280" rows="3" placeholder="Why you are moving this month, your goal, your excuses">${esc(p.bio || '')}</textarea>
      <label for="ps">Strava profile <span class="opt">(optional)</span></label>
      <input id="ps" type="url" value="${esc(p.strava_url || '')}" placeholder="https://www.strava.com/athletes/…">
      <label class="check" style="margin-top:20px"><input type="checkbox" id="pp" ${p.is_participant ? 'checked' : ''}> I am competing. Leave this unticked if you are only here to vote and cheer.</label>
      <button class="btn primary block" style="margin-top:20px">${isNew ? 'Finish signing up' : 'Save profile'}</button>
    </form>`;
}
function bindProfile(isNew) {
  const av = document.getElementById('pa');
  av.addEventListener('change', () => {
    if (!av.files[0]) return;
    const prev = document.getElementById('av-prev');
    const img = document.createElement('img');
    img.className = 'face lg'; img.id = 'av-prev'; img.alt = ''; img.src = URL.createObjectURL(av.files[0]);
    prev.replaceWith(img);
  });
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      id: S.session.user.id,
      display_name: document.getElementById('pn').value.trim(),
      hometown: document.getElementById('ph').value.trim() || null,
      mo_space_url: document.getElementById('pm').value.trim() || null,
      strava_url: document.getElementById('ps').value.trim() || null,
      is_participant: document.getElementById('pp').checked,
      bio: document.getElementById('pb').value.trim() || null,
    };
    const btn = e.submitter; if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const old = S.profile?.avatar_path;
      if (av.files[0]) row.avatar_path = await uploadImage('mo-photos', av.files[0], 600, true);
      await q(sb.from('profiles').upsert(row));
      if (row.avatar_path && old) sb.storage.from('mo-photos').remove([old]);
      await loadUser();
      toast(isNew ? 'You are signed up.' : 'Profile saved.');
      location.hash = isNew ? '#/rules' : '#/me';
      if (!isNew) route();
    } catch (err) {
      toast(friendlyError(err), true);
      if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Finish signing up' : 'Save profile'; }
    }
  });
}

async function pageMe() {
  if (needAuth('Your profile')) return;
  const s = S.isAdmin ? await api.settings() : null;
  $app.innerHTML = `
    <div class="sheet">
      <h2>${esc(first(S.profile.display_name))}</h2>
      <p><a href="#/p/${esc(S.profile.id)}">See your public page</a></p>
      ${profileForm(false)}
      ${S.isAdmin ? `<form class="panel" id="admin-form"><h3>Organizer</h3>
        <p class="small muted">Copy the raised total from the Movember team page now and then. Paused entries and Strava checks are on the <a href="#/review">Review page</a>.</p>
        <div class="pair"><div><label for="ar">Raised ($)</label><input id="ar" type="number" step="1" min="0" value="${esc(s.raised_amount)}"></div>
        <div><label for="ag">Goal ($)</label><input id="ag" type="number" step="1" min="0" value="${esc(s.goal_amount)}"></div></div>
        <label for="an">Announcement <span class="opt">(leave blank to hide)</span></label>
        <input id="an" maxlength="200" value="${esc(s.announcement || '')}">
        <button class="btn block" style="margin-top:18px">Update site</button></form>` : ''}
      <button class="btn line" id="signout" style="margin-top:22px">Sign out</button>
    </div>`;
  bindProfile(false);
  document.getElementById('signout').addEventListener('click', async () => { await sb.auth.signOut(); await loadUser(); location.hash = '#/'; });
  document.getElementById('admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await q(sb.from('site_settings').update({
        raised_amount: Number(document.getElementById('ar').value) || 0,
        goal_amount: Number(document.getElementById('ag').value) || 0,
        announcement: document.getElementById('an').value.trim() || null,
        updated_at: new Date().toISOString(),
      }).eq('id', 1));
      toast('Site updated.');
    } catch (err) { toast(friendlyError(err), true); }
  });
}

// ---------------------------------------------------------------------
// Public profile page: #/p/<id>
// ---------------------------------------------------------------------
async function pageProfile(id) {
  $app.innerHTML = loading();
  const [lb, prof, acts, mos] = await Promise.all([
    api.leaderboard(),
    sb ? q(sb.from('profiles').select('id, display_name, hometown, bio, avatar_path, mo_space_url, strava_url, is_participant').eq('id', id).maybeSingle())
       : (DEMO.lb.find((r) => r.user_id === id) || null),
    sb ? q(sb.from('activity_feed').select('*').eq('user_id', id).order('activity_date', { ascending: false }))
       : DEMO.feed.filter((a) => a.user_id === id),
    sb ? q(sb.from('mo_gallery').select('*').eq('user_id', id).order('week'))
       : DEMO.gallery.filter((g) => g.user_id === id),
  ]);
  if (!prof) { $app.innerHTML = '<div class="sheet"><h2>Nobody here</h2><p>That profile does not exist, or the person left the challenge.</p><a class="btn" href="#/">Back to standings</a></div>'; return; }

  const byKm = [...lb].sort((a, b) => Number(b.km_points) - Number(a.km_points));
  const row = lb.find((r) => r.user_id === id);
  const kmRank = byKm.findIndex((r) => r.user_id === id) + 1;
  const km = Number(row?.km_points || 0);
  const scale = Math.max(GOAL, km);
  const pic = prof.avatar_path || row?.photo_path;
  const mine = S.session?.user.id === id;
  const name = prof.display_name;

  $app.innerHTML = `
    <section class="block">
      <div class="prof-head">
        ${pic ? `<img class="face xl" src="${esc(photoUrl(pic))}" alt="">` : `<div class="face xl" aria-hidden="true">${esc(initials(name))}</div>`}
        <div class="prof-id">
          <h2>${esc(name)}</h2>
          <div class="meta">${prof.hometown ? `<span>${esc(prof.hometown)}</span>` : ''}
            ${km >= 200 ? '<span class="tag done">200 club</span>' : km >= 100 ? '<span class="tag done">100 club</span>' : km >= GOAL ? '<span class="tag done">60 done</span>' : ''}
            ${row?.strava_checked ? '<span class="tag checked">Strava checked</span>' : ''}
            ${!prof.is_participant ? '<span class="tag">Cheering</span>' : ''}</div>
          ${prof.bio ? `<p class="bio">${esc(prof.bio)}</p>` : mine ? '<p class="muted">No bio yet. <a href="#/me">Add one</a>.</p>' : ''}
          <div class="actions">
            ${prof.mo_space_url ? `<a class="btn primary" href="${esc(prof.mo_space_url)}" target="_blank" rel="noopener">Sponsor ${esc(first(name))}</a>` : ''}
            ${prof.strava_url ? `<a class="btn line" href="${esc(prof.strava_url)}" target="_blank" rel="noopener">Strava profile</a>` : ''}
            ${mine ? '<a class="btn line" href="#/me">Edit my profile</a>' : ''}
          </div>
        </div>
      </div>

      ${prof.is_participant && row ? `
      <div class="prof-stats">
        <div><b>${fmt(km)}</b>counted km</div>
        <div><b>${kmRank ? `#${kmRank}` : '–'}</b>of ${lb.length} on kilometres</div>
        <div><b>${row.mo_votes}</b>mustache vote${row.mo_votes == 1 ? '' : 's'}</div>
        <div><b>${acts.filter((a) => !a.under_review).length}</b>activit${acts.length == 1 ? 'y' : 'ies'}</div>
      </div>
      <div class="road prof-road" aria-label="${fmt(km)} of ${GOAL} km"><i style="width:${(100 * km) / scale}%"></i><s style="left:${(100 * GOAL) / scale}%"></s></div>
      <p class="small muted" style="margin-top:8px">${km >= GOAL ? `Past the ${GOAL} km floor. Every kilometre from here is extra.` : `${fmt(GOAL - km)} km to go to ${GOAL}.`}</p>` : ''}

      ${mos.length ? `<h3 style="margin-top:40px">Mustache progress</h3>
      <div class="mos small-mos">${mos.map((p) => `<figure class="mo" style="margin:0"><img src="${esc(photoUrl(p.storage_path))}" alt="${esc(name)}, ${esc(CONFIG.WEEKS.find((w) => w.n === p.week)?.label || '')}" loading="lazy">
        <figcaption class="cap"><b>${esc(CONFIG.WEEKS.find((w) => w.n === p.week)?.label || '')}</b>${p.week > 0 ? `, ${p.votes} vote${p.votes == 1 ? '' : 's'}` : ''}</figcaption></figure>`).join('')}</div>` : ''}

      ${prof.is_participant ? `<h3 style="margin-top:40px">Activity</h3>
      <ul class="log">${acts.length ? acts.map((a) => {
        const K = KINDS[a.kind];
        return `<li><div class="km">${fmt(a.distance_km)}<small>km</small></div>
          <div class="what"><div><b>${esc(K.label)}</b>, ${prettyDate(a.activity_date)}, ${duration(a.duration_min)} (${pace(a.duration_min, a.distance_km)})${a.under_review ? ' <span class="tag review">Being checked</span>' : ''}</div>
            ${a.note ? `<div>${esc(a.note)}</div>` : ''}
            <div class="links">${a.proof_url ? `<a href="${esc(a.proof_url)}" target="_blank" rel="noopener nofollow">${/strava/i.test(a.proof_url) ? 'Strava activity' : 'Proof link'}</a>` : ''}${a.proof_path ? `<a href="${esc(photoUrl(a.proof_path, 'proof'))}" target="_blank" rel="noopener">Screenshot</a>` : ''}</div></div>
          <div></div></li>`;
      }).join('') : `<li class="blank" style="display:block">${mine ? 'Nothing logged yet. <a href="#/log">Log your first kilometres</a>.' : 'Nothing logged yet.'}</li>`}</ul>` : ''}
    </section>`;
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
const ROUTES = { '': pageHome, log: pageLog, mo: pageMo, feed: pageFeed, rules: pageRules, join: pageJoin, me: pageMe, review: pageReview };

async function route() {
  // Supabase puts sign-in tokens in the URL hash; give the client a moment to read them.
  if (/access_token=|error_description=/.test(location.hash)) {
    await new Promise((r) => setTimeout(r, 300));
    history.replaceState(null, '', location.pathname + '#/join');
  }
  const parts = location.hash.replace(/^#\/?/, '').split(/[/?]/);
  const name = parts[0];
  const fn = name === 'p' && parts[1] ? () => pageProfile(decodeURIComponent(parts[1])) : (ROUTES[name] || pageHome);
  renderChrome(ROUTES[name] ? name : name === 'p' ? 'p' : '');
  try {
    if (name === 'join' && S.session && !S.profile) {
      $app.innerHTML = `<div class="sheet">${profileForm(true)}</div>`;
      bindProfile(true);
    } else {
      await fn();
    }
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<div class="sheet"><h2>That did not load</h2><p>${esc(friendlyError(err))}</p><button class="btn" onclick="location.reload()">Reload the page</button></div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
if (sb) {
  sb.auth.onAuthStateChange((evt, session) => {
    const before = S.session?.user.id || null;
    const after = session?.user.id || null;
    if (S.ready && before !== after) setTimeout(async () => { await loadUser(); route(); }, 0);
  });
}
await loadUser();
route();
