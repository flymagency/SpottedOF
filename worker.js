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

const OF_KEYWORDS = ['onlyfans', 'only fans', 'of link', 'of 🔥', '🔞', 'fans.ly', 'fansly', 'mym.fans', 'mym content'];
const COLLAB_KEYWORDS = ['collab', 'promo', 'partnership', 'partenariat', 'booking', 'dm open', 'dm for', 'contact', 'business', 'manager'];

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
      if (!item.ownerUsername && !item.username) return null;
      // item peut être un post (ownerUsername) ou un profil (username)
      if (item.ownerUsername) {
        return {
          username: item.ownerUsername,
          fullName: item.ownerFullName || '',
          biography: '',
          followersCount: 0,
          followingCount: 0,
          engagementRate: item.likesCount && item.commentsCount
            ? parseFloat(((item.likesCount + item.commentsCount) / 1000).toFixed(2)) : 0,
          platform: 'ig',
          userId: item.ownerId || '',
        };
      }
      return {
        username: item.username || '',
        fullName: item.fullName || '',
        biography: item.biography || '',
        followersCount: item.followersCount || 0,
        followingCount: item.followingCount || 0,
        engagementRate: item.engagementRate || 0,
        platform: 'ig',
        userId: item.id || '',
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
      const minScore = body.min_score || 50;

      const APIFY_TOKEN = env.APIFY_TOKEN;
      if (!APIFY_TOKEN) return json({ error: 'APIFY_TOKEN non configuré' }, 500);

      try {
        if (platform === 'ig' || platform === 'instagram') {
          // Phase 1 : scrape les posts du profil de référence pour extraire ses hashtags
          // Scrape directement les "following" du compte de référence
          // Actor dédié : apify~instagram-following-scraper
          const followingRunId = await apifyStartRun('apify~instagram-following-scraper', {
            username: handle,
            resultsLimit: resultsLimit,
          }, APIFY_TOKEN);

          return json({
            success: true,
            run_id: followingRunId,
            phase: 2, // phase unique — pas besoin d'extraire des hashtags
            handle,
            platform,
            results_limit: resultsLimit,
            min_score: minScore,
            status: 'RUNNING',
            message: `Scan des abonnements de @${handle}…`,
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

    // GET /scan-poll?run_id=xxx&phase=1|2&min_score=50&handle=xxx&platform=ig&results_limit=100
    if (request.method === 'GET' && path === '/scan-poll') {
      const runId      = url.searchParams.get('run_id');
      const phase      = parseInt(url.searchParams.get('phase') || '2');
      const minScore   = parseInt(url.searchParams.get('min_score') || '50');
      const handle     = url.searchParams.get('handle') || '';
      const platform   = url.searchParams.get('platform') || 'ig';
      const resultsLimit = Math.min(parseInt(url.searchParams.get('results_limit') || '100'), 500);
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

      // ── PHASE 1 (IG uniquement) : extraire les hashtags des posts du profil ──
      if (phase === 1 && (platform === 'ig' || platform === 'instagram')) {
        if (!Array.isArray(items) || items.length === 0) {
          return json({ done: true, error: `Aucun post trouvé pour @${handle}. Compte privé ou inexistant.` });
        }

        // Compter les hashtags dans tous les posts
        const tagCount = {};
        for (const post of items) {
          const tags = post.hashtags || [];
          for (const tag of tags) {
            const t = tag.toLowerCase().replace(/^#/, '');
            tagCount[t] = (tagCount[t] || 0) + 1;
          }
        }

        // Top 3 hashtags (les plus utilisés par ce compte)
        const topTags = Object.entries(tagCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t]) => t);

        if (topTags.length === 0) {
          // Pas de hashtags → fallback sur le nom du compte comme keyword
          topTags.push(handle);
        }

        // Démarrer la phase 2 : scraper ces hashtags
        const hashtagUrls = topTags.map(t => `https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`);
        try {
          const phase2RunId = await apifyStartRun('apify~instagram-scraper', {
            directUrls: hashtagUrls,
            resultsType: 'posts',
            resultsLimit: resultsLimit * 4, // beaucoup de posts pour avoir assez d'auteurs uniques
          }, APIFY_TOKEN);

          return json({
            done: false,
            phase: 2,
            run_id: phase2RunId,
            hashtags: topTags,
            label: `Phase 2/2 : scan des hashtags #${topTags.join(' #')}…`,
          });
        } catch(e) {
          return json({ done: true, error: e.message });
        }
      }

      // ── PHASE 2 : normaliser les items et importer ──
      if (!Array.isArray(items) || items.length === 0) {
        return json({ status: 'SUCCEEDED', done: true, saved: 0, total_found: 0, scored: 0, filtered_out: 0, message: 'Aucun profil trouvé' });
      }

      let rawProfiles = [];
      if (platform === 'ig' || platform === 'instagram') {
        // L'actor instagram-following-scraper retourne des profils directement
        // (username, fullName, biography, followersCount, followingCount, …)
        // normalizeIGPost gère aussi bien les profils que les posts
        rawProfiles = items.map(item => {
          // Format "following" actor : champs directs
          if (item.username) {
            return {
              username: item.username || '',
              fullName: item.fullName || item.name || '',
              biography: item.biography || item.bio || '',
              followersCount: item.followersCount || item.followers_count || 0,
              followingCount: item.followingCount || item.following_count || 0,
              engagementRate: item.engagementRate || 0,
              platform: 'ig',
              userId: item.id || item.pk || '',
            };
          }
          return normalizeIGPost(item);
        }).filter(Boolean);
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
      const filtered = profiles.filter(p => p.username.toLowerCase() !== handle.toLowerCase());

      // Scorer et filtrer
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
        filtered_out: filtered.length - scored.length,
        message: `${saved.length} prospects importés (score ≥ ${minScore}%)`,
      });
    }

    return json({ error: 'Route introuvable', routes: ['POST /score-profiles', 'GET /prospects', 'GET /stats', 'POST /update-status', 'POST /find-email', 'POST /scan-similar', 'GET /scan-poll'] }, 404);
  }
};
