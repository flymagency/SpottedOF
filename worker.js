// SpottedOF — Cloudflare Worker
// Endpoints:
//   POST /score-profiles  — reçoit profils Phantombuster, score + push Airtable
//   GET  /prospects       — liste les prospects depuis Airtable
//   GET  /stats           — stats globales

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── AUTH SUPABASE ───────────────────────────────────────────────────────────
// Vérifie le JWT Supabase envoyé par le client dans Authorization: Bearer <token>
const SUPABASE_URL = 'https://nsvrkogwmzrbjrtbphpb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_x7QwXgNepnb6t_2LCMniqw_zIEZ2LnR';

// Endpoints publics (pas besoin d'être connecté)
const PUBLIC_PATHS = new Set(['/scan-poll']);

async function verifyAuth(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? user : null;
  } catch { return null; }
}

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
// Limites par IP et par fenêtre glissante d'1 heure
const RATE_LIMITS = {
  '/find-email':   { max: 30,  windowSec: 3600 }, // 30 req/h — extraction email
  '/scan-similar': { max: 10,  windowSec: 3600 }, // 10 scans/h — appels Apify coûteux
  '/delete-user':  { max: 5,   windowSec: 3600 }, // 5 suppressions/h — action destructrice
  '/score-profiles': { max: 20, windowSec: 3600 }, // 20 req/h
};

async function checkRateLimit(env, ip, path) {
  // Si KV non configuré, on passe sans bloquer
  if (!env.RATE_LIMIT) return null;

  const limit = RATE_LIMITS[path];
  if (!limit) return null;

  const key = `rl:${path}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - limit.windowSec;

  // Récupérer le compteur actuel depuis KV
  let data;
  try {
    const raw = await env.RATE_LIMIT.get(key, { type: 'json' });
    data = raw && raw.ts > windowStart ? raw : { count: 0, ts: now };
  } catch {
    data = { count: 0, ts: now };
  }

  data.count += 1;
  // Stocker avec TTL = durée de fenêtre
  try {
    await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: limit.windowSec });
  } catch { /* KV write error, ne pas bloquer */ }

  if (data.count > limit.max) {
    const retryAfter = limit.windowSec - (now - data.ts);
    return new Response(JSON.stringify({
      error: 'Trop de requêtes. Réessaie dans quelques minutes.',
      retry_after: Math.max(retryAfter, 60),
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(retryAfter, 60)),
        ...CORS,
      },
    });
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ─── SCORING ────────────────────────────────────────────────────────────────
// Score sur 100 — pondération :
//   Followers        : 30 pts
//   Engagement rate  : 25 pts
//   OF link in bio   : 20 pts
//   Mots-clés bio    : 15 pts
//   Ratio f/f        : 10 pts

const OF_KEYWORDS = [
  // OnlyFans
  'onlyfans', 'only fans', 'of link', 'of 🔥', 'fans.ly', 'fansly',
  // MYM
  'mym.fans', 'mym content', 'mymfans', 'mym fans',
  // FanVu / Fanvue
  'fanvu', 'fanvue',
  // Reveal
  'reveal.co', 'revealapp',
  // Autres plateformes contenu adulte/privé
  'manyvids', 'loyalfans', 'patreon.com', 'admire.me', 'unlockd', 'findom',
  'frenchfans', 'myfans', 'justforfans',
  // Signaux génériques
  '🔞', 'lien privé', 'contenu privé', 'private content', 'content creator 18',
];
const COLLAB_KEYWORDS = ['collab', 'promo', 'partnership', 'partenariat', 'booking', 'dm open', 'dm for', 'contact', 'business', 'manager'];

// Détection plateforme privée + extraction URL
const PRIVATE_PLATFORMS = [
  { name: 'OnlyFans',   domains: ['onlyfans.com', 'fans.ly'],           keywords: ['onlyfans', 'only fans', 'of link', 'of 🔥'] },
  { name: 'Fansly',     domains: ['fansly.com'],                         keywords: ['fansly'] },
  { name: 'MYM',        domains: ['mym.fans'],                           keywords: ['mym.fans', 'mymfans', 'mym content', 'mym fans'] },
  { name: 'FanVue',     domains: ['fanvue.com', 'fanvu.com'],            keywords: ['fanvue', 'fanvu'] },
  { name: 'Reveal',     domains: ['reveal.co'],                          keywords: ['reveal.co', 'revealapp'] },
  { name: 'Patreon',    domains: ['patreon.com'],                        keywords: ['patreon.com'] },
  { name: 'FrenchFans', domains: ['frenchfans.fr'],                      keywords: ['frenchfans'] },
  { name: 'ManyVids',   domains: ['manyvids.com'],                       keywords: ['manyvids'] },
  { name: 'JustForFans',domains: ['justforfans.com'],                    keywords: ['justforfans'] },
  { name: 'LoyalFans',  domains: ['loyalfans.com'],                      keywords: ['loyalfans'] },
  { name: 'Admire.me',  domains: ['admire.me'],                          keywords: ['admire.me'] },
];

function detectPrivatePlatform(bio, externalUrl) {
  const b = (bio || '').toLowerCase();
  const ext = (externalUrl || '').toLowerCase();

  for (const p of PRIVATE_PLATFORMS) {
    // 1. Check external URL (most reliable — direct link)
    const domainMatch = p.domains.find(d => ext.includes(d));
    if (domainMatch) return { name: p.name, url: externalUrl };

    // 2. Check bio keywords
    const kwMatch = p.keywords.find(k => b.includes(k));
    if (kwMatch) {
      // Try to extract a URL from the bio that matches the platform domain
      const urlInBio = (bio || '').match(/https?:\/\/[^\s\n]+/g) || [];
      const platformUrl = urlInBio.find(u => p.domains.some(d => u.toLowerCase().includes(d)));
      return { name: p.name, url: platformUrl || null };
    }
  }

  // Generic signals (🔞 etc.) — platform unknown
  if (b.includes('🔞') || b.includes('lien privé') || b.includes('contenu privé') || b.includes('private content')) {
    return { name: 'Contenu privé', url: externalUrl || null };
  }

  return null;
}

// Niches à fort potentiel OFM — bonus/malus
const NICHE_SCORES = {
  fitness:    +8,  lifestyle: +6,  beauty:   +6,
  fashion:    +5,  travel:    +4,  wellness: +5,
  dance:      +7,  cosplay:   +8,  gaming:   +3,
  food:       -5,  sport:     +3,  comedy:   -3,
  music:      +2,  art:       +1,  pets:     -8,
};

function scoreProfile(profile) {
  let score = 0;
  const bio = (profile.biography || profile.bio || '').toLowerCase();
  const followers = profile.followersCount || profile.followers || 0;
  const following = profile.followingCount || profile.following || 1;
  const engagement = profile.engagementRate || profile.engagement || 0;
  const niche = (profile.niche || '').toLowerCase();

  // 1. Followers (30 pts) — sweet spot 10k–300k
  if (followers >= 10000 && followers < 300000) score += 30;
  else if (followers >= 5000 && followers < 10000) score += 22;
  else if (followers >= 1000 && followers < 5000) score += 14;
  else if (followers >= 300000) score += 12; // trop grosse = prix élevé
  else score += 4;

  // 2. Engagement rate (25 pts)
  if (engagement >= 6) score += 25;
  else if (engagement >= 4) score += 20;
  else if (engagement >= 2.5) score += 13;
  else if (engagement >= 1) score += 6;
  else score += 1;

  // 3. OF link détecté dans la bio (20 pts)
  const hasOfLink = OF_KEYWORDS.some(kw => bio.includes(kw));
  if (hasOfLink) score += 20;

  // 4. Mots-clés collab/promo dans la bio (15 pts)
  const collabCount = COLLAB_KEYWORDS.filter(kw => bio.includes(kw)).length;
  if (collabCount >= 2) score += 15;
  else if (collabCount === 1) score += 8;

  // 5. Ratio followers/following (10 pts) — ratio > 3 = créatrice établie
  const ratio = followers / following;
  if (ratio >= 5) score += 10;
  else if (ratio >= 3) score += 7;
  else if (ratio >= 1.5) score += 4;
  else score += 1;

  // 6. Bonus/malus niche (+8 à -8 pts)
  for (const [key, bonus] of Object.entries(NICHE_SCORES)) {
    if (niche.includes(key)) { score += bonus; break; }
  }

  return Math.min(Math.max(score, 0), 100);
}

// ─── AIRTABLE ────────────────────────────────────────────────────────────────
async function airtableRequest(env, method, path, body = null) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

async function saveProspects(env, profiles, scanSource) {
  // Airtable accepte max 10 records par requête
  const records = profiles.map(p => {
    const score = scoreProfile(p);
    const bio = p.biography || p.bio || '';
    const hasOf = OF_KEYWORDS.some(kw => bio.toLowerCase().includes(kw));
    const privPlat = detectPrivatePlatform(bio, p.externalUrl || '');

    return {
      fields: {
        handle: p.username ? `@${p.username}` : (p.handle || ''),
        name: p.fullName || p.name || '',
        platform: p.platform || 'ig',
        followers: p.followersCount || p.followers || 0,
        engagement: p.engagementRate || p.engagement || 0,
        niche: p.niche || '',
        bio: bio,
        has_of: hasOf,
        of_link: hasOf,
        private_platform: privPlat ? privPlat.name : '',
        private_platform_url: privPlat ? (privPlat.url || '') : '',
        score: score,
        status: 'nouveau',
        scan_source: scanSource || '',
        user_id: p.userId || '',
      }
    };
  });

  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await airtableRequest(env, 'POST', 'Prospects', { records: chunk });
    results.push(...(res.records || []));
  }
  return results;
}

async function getProspects(env, params) {
  const minScore = params.get('min_score') || '0';
  const platform = params.get('platform') || '';
  const status = params.get('status') || '';

  let formula = `{score} >= ${minScore}`;
  if (platform) formula = `AND(${formula}, {platform} = "${platform}")`;
  if (status) formula = `AND(${formula}, {status} = "${status}")`;

  const qs = new URLSearchParams({
    filterByFormula: formula,
    'sort[0][field]': 'score',
    'sort[0][direction]': 'desc',
    maxRecords: '200',
  });

  const res = await airtableRequest(env, 'GET', `Prospects?${qs}`);
  return (res.records || []).map(r => ({ id: r.id, ...r.fields }));
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Rate limiting ──────────────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const rateLimitResponse = await checkRateLimit(env, ip, path);
    if (rateLimitResponse) return rateLimitResponse;

    // ── Auth Supabase (tous les endpoints sauf publics) ────────────────────────
    if (!PUBLIC_PATHS.has(path)) {
      const user = await verifyAuth(request);
      if (!user) return json({ error: 'Non authentifié — connexion requise' }, 401);
    }

    // POST /score-profiles
    // Body: { profiles: [...], scan_source: "@handle" }
    if (request.method === 'POST' && path === '/score-profiles') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

      const profiles = body.profiles || body;
      if (!Array.isArray(profiles)) return json({ error: 'profiles doit être un tableau' }, 400);

      // Filtrer par score minimum (défaut 50)
      const minScore = body.min_score || 50;
      const scored = profiles
        .map(p => ({ ...p, score: scoreProfile(p) }))
        .filter(p => p.score >= minScore)
        .sort((a, b) => b.score - a.score);

      const saved = await saveProspects(env, scored, body.scan_source || '');

      return json({
        success: true,
        total_received: profiles.length,
        saved: saved.length,
        filtered_out: profiles.length - scored.length,
        message: `${saved.length} prospects sauvegardés (score ≥ ${minScore}%)`,
      });
    }

    // GET /prospects
    if (request.method === 'GET' && path === '/prospects') {
      const prospects = await getProspects(env, url.searchParams);
      return json({ prospects, count: prospects.length });
    }

    // GET /stats
    if (request.method === 'GET' && path === '/stats') {
      const all = await getProspects(env, new URLSearchParams('min_score=0'));
      const withOf = all.filter(p => p.has_of);
      const avgScore = all.length ? Math.round(all.reduce((s, p) => s + (p.score || 0), 0) / all.length) : 0;
      return json({
        total: all.length,
        with_of: withOf.length,
        to_convert: all.length - withOf.length,
        avg_score: avgScore,
      });
    }

    // POST /update-status
    if (request.method === 'POST' && path === '/update-status') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { id, status } = body;
      if (!id || !status) return json({ error: 'id et status requis' }, 400);
      const res = await airtableRequest(env, 'PATCH', `Prospects/${id}`, { fields: { status } });
      return json({ success: true, id: res.id, status });
    }

    // POST /update-note
    if (request.method === 'POST' && path === '/update-note') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { id, note } = body;
      if (!id) return json({ error: 'id requis' }, 400);
      const res = await airtableRequest(env, 'PATCH', `Prospects/${id}`, { fields: { note: note || '' } });
      return json({ success: true, id: res.id });
    }

    // DELETE /delete-prospect  — Body: { id }
    if (request.method === 'POST' && path === '/delete-prospect') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { id } = body;
      if (!id) return json({ error: 'id requis' }, 400);
      await airtableRequest(env, 'DELETE', `Prospects/${id}`);
      return json({ success: true, deleted: id });
    }

    // POST /delete-all-prospects — supprime tous les prospects (max 10 par batch Airtable)
    if (request.method === 'POST' && path === '/delete-all-prospects') {
      const all = await getProspects(env, new URLSearchParams('min_score=0'));
      const ids = all.map(p => p.id).filter(Boolean);
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const qs = chunk.map(id => `records[]=${id}`).join('&');
        await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Prospects?${qs}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` },
        });
        deleted += chunk.length;
      }
      return json({ success: true, deleted });
    }

    // POST /find-email
    // Body: { bio, id? }
    // Méthode 1 : regex email dans la bio
    // Méthode 2 : fetch les pages Linktree/Beacons/etc trouvées dans la bio
    if (request.method === 'POST' && path === '/find-email') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

      const bio = body.bio || '';
      const emails = new Set();
      const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

      // — Méthode 1 : regex direct sur la bio
      (bio.match(EMAIL_REGEX) || []).forEach(e => emails.add(e.toLowerCase()));

      // — Méthode 2 : liens dans la bio → fetch → regex
      const LINK_AGGREGATORS = [
        'linktr.ee', 'beacons.ai', 'allmylinks.com', 'linkin.bio',
        'msha.ke', 'solo.to', 'tap.bio', 'bio.link', 'lnk.bio',
        'snipfeed.co', 'koji.to', 'campsite.bio',
      ];
      const urlsInBio = bio.match(/https?:\/\/[^\s\)\]>\"]+/g) || [];

      for (const link of urlsInBio) {
        const isAggregator = LINK_AGGREGATORS.some(d => link.includes(d));
        if (!isAggregator) continue;
        try {
          const res = await fetch(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpottedOF/1.0)' },
            redirect: 'follow',
            cf: { cacheTtl: 3600 },
          });
          const html = await res.text();
          // Dé-encoder les entités HTML communes avant regex
          const decoded = html.replace(/&#64;/g, '@').replace(/&amp;/g, '&');
          (decoded.match(EMAIL_REGEX) || []).forEach(e => emails.add(e.toLowerCase()));
        } catch { /* page inaccessible, on continue */ }
      }

      // Filtrer les emails génériques non pertinents
      const BLACKLIST = ['example.com', 'sentry.io', 'w3.org', 'schema.org'];
      const filtered = [...emails].filter(e => !BLACKLIST.some(b => e.includes(b)));

      // Si un id est fourni et qu'on a trouvé un email, on le sauvegarde dans Airtable
      if (body.id && filtered.length > 0) {
        await airtableRequest(env, 'PATCH', `Prospects/${body.id}`, {
          fields: { email: filtered[0] }
        });
      }

        return json({ emails: filtered, found: filtered.length > 0, source: filtered.length > 0 ? 'bio/linktree' : null });
    }

    // ─── APIFY HELPERS ───────────────────────────────────────────────────────────

    async function apifyStartRun(actorId, input, APIFY_TOKEN) {
      const res = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
      );
      if (!res.ok) {
        let e; try { e = await res.json(); } catch { e = await res.text(); }
        const msg = e?.error?.message || e?.message || JSON.stringify(e);
        throw new Error(`Apify error (${res.status}): ${msg}`);
      }
      const data = await res.json();
      const runId = data.data?.id;
      if (!runId) throw new Error('Apify: run ID manquant — ' + JSON.stringify(data));
      return runId;
    }

    // Normalise un item Apify (post Instagram) → profil interne
    function normalizeIGPost(item) {
      // Supporte : profils complets (username), posts (ownerUsername), et champs snake_case
      const username = item.username || item.ownerUsername || item.owner?.username || '';
      if (!username) return null;

      // Followers — plusieurs noms de champ selon l'acteur Apify
      const followersCount = item.followersCount || item.followers_count
        || item.owner?.followersCount || item.ownerFollowersCount || 0;

      // Bio
      const biography = item.biography || item.bio || item.description || item.owner?.biography || '';

      // External URL
      const externalUrl = item.externalUrl || item.external_url
        || (item.externalUrls && item.externalUrls[0]) || item.owner?.externalUrl || '';

      // Engagement — post-based items on calcule depuis les likes/comments
      let engagementRate = item.engagementRate || item.engagement_rate || 0;
      if (!engagementRate && item.likesCount && followersCount > 0) {
        engagementRate = parseFloat(((item.likesCount + (item.commentsCount || 0)) / followersCount * 100).toFixed(2));
      }

      return {
        username,
        fullName: item.fullName || item.full_name || item.ownerFullName || item.name || '',
        biography,
        followersCount,
        followingCount: item.followingCount || item.following_count || item.owner?.followingCount || 0,
        postsCount: item.postsCount || item.post_count || item.igtvVideoCount || 0,
        engagementRate,
        isPrivate: item.isPrivate || item.is_private || item.private || false,
        isVerified: item.isVerified || item.is_verified || item.verified || false,
        isBusinessAccount: item.isBusinessAccount || item.is_business_account || false,
        externalUrl,
        platform: 'ig',
        userId: item.id || item.pk || item.ownerId || '',
      };
    }

    function normalizeTTItem(item) {
      const a = item.authorMeta || item;
      const u = a.name || a.uniqueId || item.uniqueId || '';
      if (!u) return null;
      return {
        username: u,
        fullName: a.nickName || a.nickname || '',
        biography: a.signature || item.signature || '',
        followersCount: a.fans || a.followerCount || item.stats?.followerCount || 0,
        followingCount: a.following || item.stats?.followingCount || 0,
        engagementRate: 0,
        platform: 'tt',
        userId: a.id || item.id || '',
      };
    }

    function normalizeTHItem(item) {
      const u = item.username || item.handle || '';
      if (!u) return null;
      return {
        username: u,
        fullName: item.name || item.fullName || '',
        biography: item.biography || item.bio || item.description || '',
        followersCount: item.followersCount || item.followers || 0,
        followingCount: item.followingCount || item.following || 0,
        engagementRate: 0,
        platform: 'th',
        userId: item.id || item.userId || '',
      };
    }

    // POST /scan-similar
    // Body: { handle, platform, results_limit, min_score }
    // Instagram : phase 1 = posts du profil → extraire hashtags
    //             phase 2 = scrape ces hashtags → profils similaires
    // TikTok/Threads : phase unique (hashtag search)
    if (request.method === 'POST' && path === '/scan-similar') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

      const handle = (body.handle || '').replace(/^@/, '').trim();
      if (!handle) return json({ error: 'handle requis' }, 400);

      const platform = (body.platform || 'ig').toLowerCase();
      const resultsLimit = Math.min(body.results_limit || 100, 500);
      const minScore = body.min_score ?? 20;

      const APIFY_TOKEN = env.APIFY_TOKEN;
      if (!APIFY_TOKEN) return json({ error: 'APIFY_TOKEN non configuré' }, 500);

      try {
        if (platform === 'ig' || platform === 'instagram') {
          // Phase 1 : récupérer la liste des following via l'acteur officiel Apify
          const followingRunId = await apifyStartRun('apify~instagram-scraper', {
            directUrls: [`https://www.instagram.com/${handle}/`],
            resultsType: 'following',
            resultsLimit: Math.min(resultsLimit, 200),
          }, APIFY_TOKEN);

          return json({
            success: true,
            run_id: followingRunId,
            phase: 1, // phase 1 → on extraira les usernames → phase 2 = détails complets
            handle,
            platform,
            results_limit: resultsLimit,
            min_score: minScore,
            status: 'RUNNING',
            message: `Phase 1/2 — récupération des abonnements de @${handle}…`,
          });
        }

        if (platform === 'tt' || platform === 'tiktok') {
          const runId = await apifyStartRun('clockworks~tiktok-scraper', {
            hashtags: [handle],
            resultsPerPage: resultsLimit * 3,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false,
          }, APIFY_TOKEN);
          return json({ success: true, run_id: runId, phase: 2, handle, platform, min_score: minScore, status: 'RUNNING' });
        }

        if (platform === 'th' || platform === 'threads') {
          const runId = await apifyStartRun('apify~threads-scraper', {
            queries: [handle],
            resultsLimit: resultsLimit * 3,
          }, APIFY_TOKEN);
          return json({ success: true, run_id: runId, phase: 2, handle, platform, min_score: minScore, status: 'RUNNING' });
        }

        return json({ error: `Plateforme non supportée : ${platform}` }, 400);

      } catch(e) {
        return json({ error: e.message }, 502);
      }

      return json({
        success: true,
        run_id: runId,
        handle,
        platform,
        min_score: minScore,
        status: 'RUNNING',
        message: `Scan ${platform.toUpperCase()} lancé pour @${handle} — ${resultsLimit} profils max`,
      });
    }

    // GET /scan-poll?run_id=xxx&phase=1|2&min_score=50&handle=xxx&platform=ig&results_limit=100&filters={}
    if (request.method === 'GET' && path === '/scan-poll') {
      const runId      = url.searchParams.get('run_id');
      const phase      = parseInt(url.searchParams.get('phase') || '2');
      const minScore   = parseInt(url.searchParams.get('min_score') || '20');
      const handle     = url.searchParams.get('handle') || '';
      const platform   = url.searchParams.get('platform') || 'ig';
      const resultsLimit = Math.min(parseInt(url.searchParams.get('results_limit') || '100'), 500);
      let filters = {};
      try { filters = JSON.parse(url.searchParams.get('filters') || '{}'); } catch {}
      if (!runId) return json({ error: 'run_id requis' }, 400);

      const APIFY_TOKEN = env.APIFY_TOKEN;

      // Vérifier le statut du run en cours
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusRes.json();
      const status = statusData.data?.status;
      const datasetId = statusData.data?.defaultDatasetId;

      if (status === 'RUNNING' || status === 'READY' || status === 'ABORTING') {
        const label = phase === 1 ? 'Analyse du profil de référence…' : 'Scan des profils similaires…';
        return json({ status, run_id: runId, done: false, phase, label });
      }

      if (status !== 'SUCCEEDED') {
        return json({ status, done: true, error: 'Run Apify échoué ou annulé', run_id: runId });
      }

      // Run terminé — récupérer les items
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=500`
      );
      const items = await itemsRes.json();

      // ── PHASE 1 (IG) : following list → extraire usernames → lancer scrape de détails ──
      if (phase === 1 && (platform === 'ig' || platform === 'instagram')) {
        if (!Array.isArray(items) || items.length === 0) {
          return json({ done: true, error: `Aucun abonnement trouvé pour @${handle}. Compte privé ou inexistant ?` });
        }

        // Extraire les usernames (on exclut les privés et le compte de référence)
        const usernames = items
          .filter(p => p.username && !p.isPrivate && p.username.toLowerCase() !== handle.toLowerCase())
          .map(p => p.username)
          .slice(0, Math.min(resultsLimit, 200)); // max 200 profils à détailler

        if (usernames.length === 0) {
          return json({ done: true, error: `Tous les abonnements de @${handle} sont des comptes privés.` });
        }

        // Phase 2 : scraper les détails complets de ces profils
        try {
          const phase2RunId = await apifyStartRun('apify~instagram-profile-scraper', {
            usernames: usernames,
          }, APIFY_TOKEN);

          return json({
            done: false,
            phase: 2,
            run_id: phase2RunId,
            total_following: items.length,
            profiles_to_detail: usernames.length,
            label: `Phase 2/2 — récupération des détails de ${usernames.length} profils…`,
          });
        } catch(e) {
          return json({ done: true, error: e.message });
        }
      }

      // ── PHASE 2 / FINAL : normaliser les profils détaillés et importer ──
      if (!Array.isArray(items) || items.length === 0) {
        return json({ status: 'SUCCEEDED', done: true, saved: 0, total_found: 0, scored: 0, filtered_out: 0, message: 'Aucun profil trouvé' });
      }

      let rawProfiles = [];
      if (platform === 'ig' || platform === 'instagram') {
        // Les items sont des profils complets (resultsType: 'details')
        rawProfiles = items.map(item => normalizeIGPost(item)).filter(Boolean);
      } else if (platform === 'tt' || platform === 'tiktok') {
        rawProfiles = items.map(normalizeTTItem).filter(Boolean);
      } else if (platform === 'th' || platform === 'threads') {
        rawProfiles = items.map(normalizeTHItem).filter(Boolean);
      }

      // Dédupliquer par username
      const seen = new Set();
      const profiles = rawProfiles.filter(p => {
        if (!p.username || seen.has(p.username)) return false;
        seen.add(p.username);
        return true;
      });

      // Exclure le compte de référence lui-même
      const deduped = profiles.filter(p => p.username.toLowerCase() !== handle.toLowerCase());

      // ── Appliquer les critères de filtrage ──────────────────────────────────
      const LANG_KEYWORDS = {
        fr: ['je','mon','ma','les','des','une','est','avec','pour','dans','sur','pas','plus','être','bonjour','merci','salut'],
        en: ['the','my','and','for','with','your','you','our','are','have','follow','link','bio','check','out','dm'],
        es: ['mi','el','la','los','las','con','por','que','una','soy','hola','gracias','aquí'],
        it: ['il','la','le','un','una','con','per','sono','ciao','grazie','qui'],
        de: ['ich','mein','die','der','das','mit','für','und','hallo','danke','hier'],
        pt: ['eu','meu','minha','com','para','que','obrigada','olá','aqui'],
      };
      function detectBioLang(bio) {
        if (!bio) return 'en';
        const b = bio.toLowerCase();
        let best = 'en', bestScore = 0;
        for (const [lang, kws] of Object.entries(LANG_KEYWORDS)) {
          const s = kws.filter(k => b.includes(k)).length;
          if (s > bestScore) { bestScore = s; best = lang; }
        }
        return best;
      }

      const NICHE_KEYWORDS = {
        fitness: ['fitness','gym','workout','sport','muscle','bodybuilding','crossfit','running','yoga','pilates'],
        beauty: ['beauty','makeup','skincare','cosmetic','glam','mua','beauté','maquillage'],
        lifestyle: ['lifestyle','life','daily','routine','vlog','content','creator'],
        cosplay: ['cosplay','anime','manga','gamer','geek','nerd','otaku','comic'],
        dance: ['dance','dancer','dancing','choreography','ballet','hip hop','twerk'],
        fashion: ['fashion','style','ootd','outfit','model','modelling','influencer'],
        travel: ['travel','traveler','wanderlust','adventure','explore','trip','voyage'],
        wellness: ['wellness','health','mindfulness','meditation','mental health','holistic'],
        gaming: ['gaming','gamer','twitch','streamer','esport','gameplay'],
        music: ['music','singer','artist','musician','producer','dj','rap','pop'],
      };
      function detectNiche(bio) {
        if (!bio) return '';
        const b = bio.toLowerCase();
        for (const [niche, kws] of Object.entries(NICHE_KEYWORDS)) {
          if (kws.some(k => b.includes(k))) return niche;
        }
        return '';
      }

      const OF_DETECT = [
        'onlyfans','only fans','fans.ly','fansly',
        'mym.fans','mym content','mymfans','mym fans',
        'fanvu','fanvue',
        'reveal.co','revealapp',
        'manyvids','loyalfans','patreon.com','admire.me','unlockd','findom',
        'frenchfans','myfans','justforfans',
        '🔞','lien privé','contenu privé','private content','content creator 18',
      ];

      const filtered = deduped.filter(p => {
        const bio = (p.biography || '').toLowerCase();

        // Profil public uniquement (is_private est dans les données phase 1)
        // En phase 2 on a isPrivate dans les détails
        if (filters.public_only && p.isPrivate) return false;

        // Déjà OF/Fansly détecté
        const hasOf = OF_DETECT.some(k => bio.includes(k));
        if (filters.no_of && hasOf) return false;   // exclure ceux qui ont déjà OF
        if (filters.has_of && !hasOf) return false; // garder seulement ceux qui ont OF

        // Non vérifié uniquement
        if (filters.no_verified && p.isVerified) return false;

        // Followers min/max
        const fc = p.followersCount || 0;
        if (filters.followers_min > 0 && fc < filters.followers_min) return false;
        if (filters.followers_max > 0 && fc > filters.followers_max) return false;

        // 1. Nombre de posts minimum
        if (filters.posts_min > 0 && (p.postsCount || 0) < filters.posts_min) return false;

        // 2. Compte business
        if (filters.no_business_account && p.isBusinessAccount) return false;

        // 3. Lien externe présent (Linktree, Beacons, etc.)
        if (filters.has_external_url && !p.externalUrl) return false;

        // 4. Mots-clés à inclure (bio doit contenir au moins un)
        if (filters.keywords_include && filters.keywords_include.length > 0) {
          if (!filters.keywords_include.some(kw => bio.includes(kw))) return false;
        }

        // 4b. Mots-clés à exclure (bio ne doit contenir aucun)
        if (filters.keywords_exclude && filters.keywords_exclude.length > 0) {
          if (filters.keywords_exclude.some(kw => bio.includes(kw))) return false;
        }

        // 5. Ratio followers/following
        const following = p.followingCount || 1;
        const ratio = (p.followersCount || 0) / following;
        if (filters.ratio_min > 0 && ratio < filters.ratio_min) return false;

        // 6. Taux d'engagement minimum
        if (filters.engagement_min > 0 && (p.engagementRate || 0) < filters.engagement_min) return false;

        // Langue
        if (filters.langs && filters.langs.length > 0) {
          const lang = detectBioLang(p.biography);
          if (!filters.langs.includes(lang)) return false;
        }

        // Niche
        if (filters.niches && filters.niches.length > 0) {
          const niche = detectNiche(p.biography) || p.niche || '';
          if (!filters.niches.includes(niche)) return false;
        }

        return true;
      });

      // Enrichir avec niche détectée
      filtered.forEach(p => {
        if (!p.niche) p.niche = detectNiche(p.biography);
      });

      // Scorer et filtrer par score minimum
      const scored = filtered
        .map(p => ({ ...p, score: scoreProfile(p) }))
        .filter(p => p.score >= minScore)
        .sort((a, b) => b.score - a.score);

      const scanSource = `@${handle} (${platform})`;
      const saved = scored.length > 0
        ? await saveProspects(env, scored, scanSource)
        : [];

      return json({
        status: 'SUCCEEDED',
        done: true,
        total_found: items.length,
        unique_profiles: profiles.length,
        scored: scored.length,
        saved: saved.length,
        filtered_out: deduped.length - scored.length,
        message: `${saved.length} prospects importés (score ≥ ${minScore}%)`,
      });
    }

    // POST /send-invite-email
    // Body: { to, inviterEmail, teamName, role, inviteUrl }
    if (request.method === 'POST' && path === '/send-invite-email') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { to, inviterEmail, teamName, role, inviteUrl } = body;
      if (!to || !inviteUrl) return json({ error: 'to et inviteUrl requis' }, 400);

      const ROLE_FR = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };
      const roleFr = ROLE_FR[role] || role;

      const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f9;font-family:'Inter',Arial,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#4f46e5,#db2777);padding:32px 36px;text-align:center">
      <div style="font-size:32px;margin-bottom:8px">👥</div>
      <div style="color:white;font-size:22px;font-weight:800;letter-spacing:-0.5px">SpottedOF</div>
      <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Invitation à rejoindre une équipe</div>
    </div>
    <!-- Body -->
    <div style="padding:32px 36px">
      <p style="font-size:15px;color:#0f1117;line-height:1.6;margin:0 0 16px">Bonjour 👋</p>
      <p style="font-size:15px;color:#0f1117;line-height:1.6;margin:0 0 24px">
        <strong>${inviterEmail}</strong> t'invite à rejoindre l'équipe <strong>${teamName}</strong> sur SpottedOF avec le rôle <strong>${roleFr}</strong>.
      </p>
      <!-- CTA -->
      <div style="text-align:center;margin:28px 0">
        <a href="${inviteUrl}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#db2777);color:white;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700">
          Rejoindre l'équipe →
        </a>
      </div>
      <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0">
        Ce lien est valable 7 jours. Si tu n'as pas de compte SpottedOF, tu pourras en créer un gratuitement en cliquant sur le bouton ci-dessus.
      </p>
    </div>
    <!-- Footer -->
    <div style="background:#f4f5f9;padding:16px 36px;text-align:center;border-top:1px solid #e2e4ec">
      <p style="font-size:11px;color:#9ca3af;margin:0">SpottedOF — Propulsé par FlyMagency · <a href="https://flymagency.github.io/SpottedOF/app.html" style="color:#4f46e5;text-decoration:none">spottedof.com</a></p>
    </div>
  </div>
</body>
</html>`;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'SpottedOF <noreply@spottedof.com>',
          to: [to],
          subject: `${inviterEmail} t'invite dans l'équipe ${teamName} sur SpottedOF`,
          html,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return json({ error: err.message || 'Erreur envoi email' }, 502);
      }
      return json({ success: true, to });
    }

    // POST /delete-user
    // Body: { userId }
    if (request.method === 'POST' && path === '/delete-user') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { userId } = body;
      if (!userId) return json({ error: 'userId requis' }, 400);

      const SUPABASE_URL = 'https://nsvrkogwmzrbjrtbphpb.supabase.co';
      const serviceKey = env.SUPABASE_SERVICE_KEY;
      if (!serviceKey) return json({ error: 'SUPABASE_SERVICE_KEY non configuré' }, 500);

      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
        },
      });

      if (!res.ok) {
        let err; try { err = await res.json(); } catch { err = {}; }
        return json({ error: err.message || `Erreur Supabase (${res.status})` }, res.status);
      }
      return json({ success: true, deleted: userId });
    }

    return json({ error: 'Route introuvable', routes: ['POST /score-profiles', 'GET /prospects', 'GET /stats', 'POST /update-status', 'POST /find-email', 'POST /scan-similar', 'GET /scan-poll', 'POST /delete-user'] }, 404);
  }
};
