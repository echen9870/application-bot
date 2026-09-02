/**
 * ats.mjs — Applicant Tracking System URL templates, parsers, and link detection
 *
 * Centralized knowledge of Greenhouse, Ashby, Lever, and SmartRecruiters:
 *   - boardApi(slug)     → board listing endpoint URL
 *   - jobApi(slug, id)   → individual job endpoint URL (GH only — others use board)
 *   - parse(json, ...)   → API JSON → normalized job objects
 *   - parseLink(host, p) → job URL → { type, slug, id } or null
 *
 * Adding a new ATS only requires adding one entry here.
 */

import { postJson, fetchText, fetchWithTimeout } from './fetch.mjs';

// SmartRecruiters paging. 100 is the API's hard per-response cap. The 2,000
// ceiling bounds a scan at 20 requests per company — enough for every tech board
// we track, while not spending 250 requests walking Dominos' 24k retail postings
// (which the title filter discards anyway).
const SR_PAGE_SIZE = 100;
const SR_MAX_POSTINGS = 2000;

function toDate(val) {
  if (!val) return '';
  const d = new Date(val);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// Decode HTML entities, strip tags, collapse whitespace, lowercase.
// Used to normalize job descriptions for storage (data/job-descriptions.json)
// and downstream ML scoring (src/ml/scorer.mjs). Greenhouse double-encodes real
// HTML as entities (&lt;p&gt;), so decode first, then strip the resulting tags.
export function cleanDescription(html) {
  if (!html) return '';
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')      // decode last to avoid double-decoding
    .replace(/<[^>]+>/g, ' ')    // strip HTML tags
    .replace(/\s{2,}/g, ' ')     // collapse whitespace
    .trim()
    .toLowerCase();
}

// Workday's listing API only returns human-readable strings like "Posted Today" /
// "Posted 5 Days Ago" / "Posted 30+ Days Ago". Convert to ISO date.
function workdayPostedToDate(s) {
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower.includes('today'))     return new Date().toISOString().slice(0, 10);
  if (lower.includes('yesterday')) return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const m = lower.match(/posted\s+(\d+)\+?\s+days?\s+ago/);
  if (m) return new Date(Date.now() - parseInt(m[1]) * 86_400_000).toISOString().slice(0, 10);
  return '';   // unknown format — let recency filter treat as old
}

// Workday collapses a multi-location posting's locationsText to a bare count
// ("6 Locations"), which carries no country signal and gets dropped as non-US.
// The primary location survives in externalPath (/job/OFallon-Missouri/...), so
// fall back to that slug. It discriminates correctly — a Paris-France slug still
// reads as non-US.
function isWorkdayMultiLocation(j) {
  return /^\d+\s+locations?$/i.test((j.locationsText || '').trim());
}

function workdayLocation(j) {
  if (j._resolvedLocation) return j._resolvedLocation;
  const text = j.locationsText || '';
  if (!isWorkdayMultiLocation(j)) return text;
  const slug = (j.externalPath || '').split('/job/')[1]?.split('/')[0];
  return slug ? slug.replace(/-/g, ' ') : text;
}

// The job-detail endpoint spells out every location plus an explicit country,
// which the listing response omits. Only multi-location postings need it, so
// this stays a small number of extra requests; anything that fails silently
// keeps the externalPath-slug fallback above.
const WORKDAY_MAX_DETAIL_FETCHES = 30;

async function resolveWorkdayMultiLocations(postings, info, fetchJson, opts) {
  if (!fetchJson || !info) return;
  const multi = postings.filter(isWorkdayMultiLocation).slice(0, WORKDAY_MAX_DETAIL_FETCHES);
  for (const j of multi) {
    try {
      // externalPath already begins with "/job/", so the base takes no extra segment.
      const d = await fetchJson(`https://${info.host}/wday/cxs/${info.tenant}/${info.site}${j.externalPath}`, opts);
      const pi = d?.jobPostingInfo || {};
      const locs = [pi.location, ...(pi.additionalLocations || [])].filter(Boolean);
      if (!locs.length) continue;
      const joined  = locs.join('; ');
      const country = pi.country?.descriptor;
      // Some tenants already spell the country into each location entry.
      j._resolvedLocation = country && !joined.includes(country) ? `${joined}, ${country}` : joined;
    } catch { /* keep the slug fallback */ }
  }
}

// Parse a Workday board URL → { host, tenant, site }.
// Accepts the public board URL (https://capitalone.wd12.myworkdayjobs.com/Capital_One)
// or the API URL (https://capitalone.wd12.myworkdayjobs.com/wday/cxs/capitalone/Capital_One/jobs).
function parseWorkdayUrl(url) {
  try {
    const u = new URL(url);
    if (!/\.myworkdayjobs\.com$/.test(u.hostname)) return null;
    const tenant = u.hostname.split('.')[0];
    let site;
    const cxs = u.pathname.match(/\/wday\/cxs\/[^/]+\/([^/]+)\//);
    if (cxs) site = cxs[1];
    else {
      const seg = u.pathname.split('/').filter(Boolean);
      site = seg[0];
    }
    if (!tenant || !site) return null;
    return { host: u.hostname, tenant, site };
  } catch { return null; }
}

// Single-token queries swept by the amazon adapter. Multi-word values are useless here
// (base_query phrase-matches), and these ten cover disjoint slices of the US board:
// engineer ~4.8k hits, developer ~640, 2026 ~820, 2027 ~72, intern ~49, graduate ~46.
const AMAZON_QUERIES = [
  'engineer', 'developer', 'scientist', '2026', '2027',
  'intern', 'graduate', 'university', 'co-op', 'apprentice',
];

export const ATS = {
  greenhouse: {
    boardApi: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    jobApi:   (slug, id) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`,
    parse(json, company, slug = '') {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     j.absolute_url || '',
        location: j.location?.name || '',
        // first_published is the true post date; updated_at bumps on any edit
        // (comp band tweak, location add) and was admitting years-old postings
        // through the recency filter. Fall back to updated_at only if a board
        // omits first_published (not observed, but keep the scan alive if so).
        posted:   toDate(j.first_published || j.updated_at),
        _slug:    slug,           // for fetchDescription
        _id:      String(j.id || ''),
      }));
    },
    parseLink(host, path) {
      if (host !== 'job-boards.greenhouse.io' && host !== 'boards.greenhouse.io') return null;
      const m = path.match(/^\/([^/]+)\/jobs\/(\d+)/);
      return m ? { type: 'greenhouse', slug: m[1], id: m[2] } : null;
    },
    // GH list API omits descriptions — fetch the individual job to get .content.
    async fetchDescription(job, fetchJson, opts) {
      if (!job._slug || !job._id) return '';
      try {
        const json = await fetchJson(ATS.greenhouse.jobApi(job._slug, job._id), opts);
        return cleanDescription(json.content || '');
      } catch { return ''; }
    },
  },

  ashby: {
    boardApi: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:        j.title || '',
        link:        j.jobUrl || '',
        location:    j.location || '',
        posted:      toDate(j.publishedAt || j.updatedAt),
        description: (j.descriptionPlain || '').toLowerCase(),
      }));
    },
    parseLink(host, path) {
      if (host !== 'jobs.ashbyhq.com') return null;
      const m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
      return m ? { type: 'ashby', slug: m[1], id: m[2].toLowerCase() } : null;
    },
  },

  lever: {
    boardApi: slug => `https://api.lever.co/v0/postings/${slug}`,
    jobApi:   (slug, id) => `https://api.lever.co/v0/postings/${slug}/${id}`,
    parse(json, company) {
      return (Array.isArray(json) ? json : []).map(j => ({
        company,
        role:     j.text || '',
        link:     j.hostedUrl || '',
        location: j.categories?.location || '',
        posted:   toDate(j.createdAt),
        // Lever's board listing already includes the full description — no extra fetch needed.
        description: cleanDescription(j.descriptionPlain || j.description || ''),
      }));
    },
    parseLink(host, path) {
      if (host !== 'jobs.lever.co') return null;
      const m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
      return m ? { type: 'lever', slug: m[1], id: m[2].toLowerCase() } : null;
    },
  },

  workable: {
    // Workable's public widget endpoint: GET /api/v1/widget/accounts/{slug}
    // Returns all published jobs in a single response (no pagination needed for typical boards).
    // Requires a real User-Agent header — Workable rejects requests without one (403).
    // Job URL: https://apply.workable.com/j/{shortcode}
    boardApi: slug => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
    async fetchAll(url, _fetchJson, opts) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(opts?.timeoutMs || 10_000),
        });
        if (!r.ok) return { jobs: [] };
        const j = await r.json();
        return { jobs: j.jobs || [] };
      } catch { return { jobs: [] }; }
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        const usLoc = (j.locations || []).find(l => l.country === 'United States') || {};
        const location = j.country === 'United States'
          ? (j.city && j.state ? `${j.city}, ${j.state}` : j.country)
          : (usLoc.city && usLoc.region ? `${usLoc.city}, ${usLoc.region}` : (j.telecommuting ? 'Remote' : `${j.city || ''}${j.country ? ', ' + j.country : ''}`));
        return {
          company,
          role:     j.title || '',
          link:     j.url || j.shortlink || '',
          location,
          posted:   j.published_on || j.created_at || '',
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'apply.workable.com') return null;
      const m = path.match(/^\/j\/([A-Z0-9]+)/);
      return m ? { type: 'workable', id: m[1] } : null;
    },
  },

  breezy: {
    // Breezy HR exposes every published posting as a flat JSON array at
    // https://{slug}.breezy.hr/json — no pagination, no auth.
    // Job URL: https://{slug}.breezy.hr/p/{friendly_id}
    boardApi: slug => `https://${slug}.breezy.hr/json`,
    parse(json, company) {
      return (Array.isArray(json) ? json : []).map(j => ({
        company,
        role:     j.name || '',
        link:     j.url || '',
        // location.name is already "City, ST"; fall back to the country for remote roles.
        location: j.location?.name || j.location?.country?.name || '',
        posted:   toDate(j.published_date),
      }));
    },
    parseLink(host, path) {
      const h = host.match(/^([a-z0-9-]+)\.breezy\.hr$/i);
      if (!h) return null;
      const m = path.match(/^\/p\/([a-z0-9-]+)/i);
      return m ? { type: 'breezy', slug: h[1], id: m[1] } : null;
    },
  },

  deel: {
    // Deel's hosted job boards (jobs.deel.com/{slug}) are a Next.js app with no public
    // JSON API — every endpoint under /api 404s. The full posting list is server-rendered
    // into the RSC payload, though, as self.__next_f.push([1,"...json..."]) chunks, so we
    // reassemble those chunks and pull the posting records out of the result.
    // Job URL: https://jobs.deel.com/{slug}/job-details/{postingId}/overview
    //
    // This parses a private payload shape rather than a supported API, so it is more
    // brittle than the other adapters here — a Deel frontend rewrite will break it. It
    // fails soft (returns []) so a break shows up as an "Empty ATS" line, not a scan error.
    boardApi: slug => `https://jobs.deel.com/${slug}`,
    async fetchAll(url, _fetchJson, opts) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          signal: AbortSignal.timeout(opts?.timeoutMs || 10_000),
        });
        if (!r.ok) return { _rsc: '', _slug: '' };
        const html = await r.text();
        // Each push carries a JS string literal; concatenating them rebuilds the payload.
        const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)];
        let rsc = chunks.map(m => m[1]).join('');
        try { rsc = JSON.parse(`"${rsc}"`); } catch { rsc = rsc.replace(/\\"/g, '"'); }
        return { _rsc: rsc, _slug: (url.match(/jobs\.deel\.com\/([^/?#]+)/) || [])[1] || '' };
      } catch { return { _rsc: '', _slug: '' }; }
    },
    parse(json, company) {
      const { _rsc: rsc = '', _slug: slug = '' } = json || {};
      if (!rsc) return [];
      // Posting records start with {"id":"<uuid>","jobId":"<uuid>","title":"..."; slice each
      // record at the next record boundary so location/date lookups stay inside one posting.
      const starts = [...rsc.matchAll(/\{"id":"([0-9a-f-]{36})","jobId":"[0-9a-f-]{36}","title":"((?:[^"\\]|\\.)*)"/g)];
      return starts.map((m, i) => {
        const seg = rsc.slice(m.index, starts[i + 1]?.index ?? m.index + 4000);
        const loc = seg.match(/"jobLocations":\[\{[^\]]*?"location":\{[^}]*?"name":"((?:[^"\\]|\\.)*)"/);
        const created = seg.match(/"createdAt":"([\dT:.\-]+Z)"/);
        return {
          company,
          role:     m[2].replace(/\\(.)/g, '$1').trim(),
          link:     `https://jobs.deel.com/${slug}/job-details/${m[1]}/overview`,
          // Remote-only postings carry no jobLocations entry.
          location: loc ? loc[1].replace(/\\(.)/g, '$1') : 'Remote',
          posted:   created ? toDate(created[1]) : '',
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'jobs.deel.com') return null;
      const m = path.match(/^\/([^/]+)\/job-details\/([0-9a-f-]{36})/i);
      return m ? { type: 'deel', slug: m[1], id: m[2] } : null;
    },
  },

  rippling: {
    // Rippling ATS public board API — a flat JSON array, no auth or paging:
    //   https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
    // Job URL: https://ats.rippling.com/{slug}/jobs/{uuid} (given as `url`).
    // No post date is exposed on either the list or the per-job endpoint, so `posted`
    // is left empty — jobs.mjs treats empty as passing the recency filter.
    boardApi: slug => `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`,
    parse(json, company) {
      return (Array.isArray(json) ? json : []).map(j => ({
        company,
        role:     j.name || '',
        link:     j.url || '',
        location: j.workLocation?.label || '',
        posted:   '',
      }));
    },
    parseLink(host, path) {
      if (host !== 'ats.rippling.com') return null;
      const m = path.match(/^\/([^/]+)\/jobs\/([0-9a-f-]{36})/i);
      return m ? { type: 'rippling', slug: m[1], id: m[2] } : null;
    },
  },

  radancy: {
    // Radancy / TalentBrew career sites (jobs.{company}.com) expose their search as
    // JSON-wrapped HTML at /search-jobs/results?<query>. The api: URL in portals.yml is
    // that full results URL, so per-company filters (Keywords, category facets) are
    // expressed there rather than in code.
    // Job URL: {origin}{href} from each result anchor.
    // Listings carry no post date, so `posted` is left empty (passes recency).
    // Locations are often the literal "Multiple Locations", which will not pass isUS().
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
      if (!origin) return { _items: [], _origin: '' };
      const items = [];
      const PER = 100;
      const base = url.replace(/[?&]CurrentPage=\d+/i, '');
      const sep = base.includes('?') ? '&' : '?';
      // 5 pages = 500 jobs.
      for (let page = 1; page <= 5; page++) {
        let html;
        try {
          const r = await fetch(`${base}${sep}CurrentPage=${page}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(opts?.timeoutMs || 10_000),
          });
          if (!r.ok) break;
          html = (await r.json())?.results || '';
        } catch { break; }
        const found = [...html.matchAll(
          /<a href="([^"]+)"[\s\S]{0,400}?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]{0,300}?<span class="job-location">([^<]*)</g
        )];
        items.push(...found.map(m => ({ href: m[1], title: m[2], loc: m[3] })));
        if (found.length < PER) break;
      }
      return { _items: items, _origin: origin };
    },
    parse(json, company) {
      const { _items: items = [], _origin: origin = '' } = json || {};
      const unescape = s => String(s || '')
        .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '').trim();
      return items.map(i => ({
        company,
        role:     unescape(i.title),
        link:     i.href.startsWith('http') ? i.href : `${origin}${i.href}`,
        location: unescape(i.loc),
        posted:   '',
      }));
    },
    parseLink(host, path) {
      // /job/{city}/{title-slug}/{orgId}/{jobId}
      const m = path.match(/^\/job\/[^/]+\/[^/]+\/(\d+)\/(\d+)/);
      return m ? { type: 'radancy', host, orgId: m[1], id: m[2] } : null;
    },
  },

  gem: {
    // Gem-hosted boards (jobs.gem.com/{slug}) render client-side from a GraphQL API at
    // https://jobs.gem.com/api/public/graphql. The JobBoardList query below is the one
    // the board's own bundle sends; `boardId` is the vanity slug from the URL.
    // The api: URL in portals.yml is the board page, e.g. https://jobs.gem.com/retool
    // Job URL: https://jobs.gem.com/{slug}/{postingId}
    // The schema exposes no post date, so `posted` is left empty (passes recency).
    boardApi: slug => `https://jobs.gem.com/${slug}`,
    async fetchAll(url, _fetchJson, opts) {
      const slug = (url.match(/jobs\.gem\.com\/([^/?#]+)/) || [])[1] || '';
      if (!slug) return { _postings: [], _slug: '' };
      const query = `query JobBoardList($boardId: String!) {
        oatsExternalJobPostings(boardId: $boardId) {
          jobPostings { id extId title locations { name city isoCountry isRemote } }
        }
      }`;
      try {
        const r = await fetch('https://jobs.gem.com/api/public/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: JSON.stringify({ query, variables: { boardId: slug } }),
          signal: AbortSignal.timeout(opts?.timeoutMs || 10_000),
        });
        if (!r.ok) return { _postings: [], _slug: slug };
        const j = await r.json();
        return { _postings: j?.data?.oatsExternalJobPostings?.jobPostings || [], _slug: slug };
      } catch { return { _postings: [], _slug: slug }; }
    },
    parse(json, company) {
      const { _postings: postings = [], _slug: slug = '' } = json || {};
      return postings.map(j => {
        const locs = j.locations || [];
        const loc = locs[0] || {};
        return {
          company,
          role:     j.title || '',
          link:     `https://jobs.gem.com/${slug}/${j.id}`,
          location: loc.isRemote ? 'Remote'
                  : [loc.name || loc.city, loc.isoCountry].filter(Boolean).join(', '),
          posted:   '',
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'jobs.gem.com') return null;
      // Posting ids are base64 and can carry "=" padding.
      const m = path.match(/^\/([^/]+)\/([A-Za-z0-9_=-]{8,})/);
      return m ? { type: 'gem', slug: m[1], id: m[2] } : null;
    },
  },

  bamboohr: {
    // BambooHR hosted boards expose the full opening list as JSON at
    //   https://{slug}.bamboohr.com/careers/list
    // Job URL: https://{slug}.bamboohr.com/careers/{id}
    // No post date is exposed, so `posted` is left empty (passes the recency filter).
    boardApi: slug => `https://${slug}.bamboohr.com/careers/list`,
    async fetchAll(url, _fetchJson, opts) {
      // BambooHR 403s requests without a browser User-Agent.
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(opts?.timeoutMs || 10_000),
        });
        if (!r.ok) return { result: [], _slug: '' };
        const j = await r.json();
        return { result: j.result || [], _slug: (url.match(/https:\/\/([^.]+)\.bamboohr\.com/) || [])[1] || '' };
      } catch { return { result: [], _slug: '' }; }
    },
    parse(json, company) {
      const { result = [], _slug: slug = '' } = json || {};
      return result.map(j => {
        const l = j.location || {};
        const a = j.atsLocation || {};
        const city = l.city || a.city || '';
        const region = l.state || a.state || a.province || '';
        const country = a.country || '';
        return {
          company,
          role:     j.jobOpeningName || '',
          link:     `https://${slug}.bamboohr.com/careers/${j.id}`,
          location: j.isRemote ? 'Remote' : [city, region, country].filter(Boolean).join(', '),
          posted:   '',
        };
      });
    },
    parseLink(host, path) {
      const h = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/i);
      if (!h) return null;
      const m = path.match(/^\/careers\/(\d+)/);
      return m ? { type: 'bamboohr', slug: h[1], id: m[1] } : null;
    },
  },

  eightfold: {
    // Eightfold AI career sites expose a public search API:
    //   https://{tenant}.eightfold.ai/api/apply/v2/jobs?domain={domain}&start=N&num=M
    // `domain` is the customer's own domain and must match what the tenant is
    // registered under, so the full URL (with domain) is what goes in portals.yml.
    // Job URL: https://{tenant}.eightfold.ai/careers/job/{id}
    boardApi: url => url,
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      const base = url.replace(/[?&]start=\d+/, '');
      const sep = base.includes('?') ? '&' : '?';
      // The API returns 10 per call and ignores a larger `num`, so page by `start`.
      const SIZE = 10;
      // 25 pages = 250 jobs, above the couple hundred these boards carry.
      for (let page = 0; page < 25; page++) {
        let json;
        try { json = await fetchJson(`${base}${sep}start=${page * SIZE}&num=${SIZE}`, opts); } catch { break; }
        const positions = json?.positions || [];
        all.push(...positions);
        if (positions.length < SIZE || all.length >= (json?.count ?? 0)) break;
      }
      return { _positions: all, _tenant: (url.match(/https:\/\/([^.]+)\.eightfold\.ai/) || [])[1] || '' };
    },
    parse(json, company) {
      const { _positions: positions = [], _tenant: tenant = '' } = json || {};
      return positions.map(j => ({
        company,
        role:     j.name || j.posting_name || '',
        link:     `https://${tenant}.eightfold.ai/careers/job/${j.id}`,
        // Already "City, State, Country"; multi-location roles list the rest in `locations`.
        location: j.location || (j.locations || [])[0] || '',
        posted:   j.t_create ? toDate(new Date(j.t_create * 1000).toISOString()) : '',
      }));
    },
    parseLink(host, path) {
      const h = host.match(/^([a-z0-9-]+)\.eightfold\.ai$/i);
      if (!h) return null;
      const m = path.match(/^\/careers\/job\/(\d+)/);
      return m ? { type: 'eightfold', tenant: h[1], id: m[1] } : null;
    },
  },

  phenom: {
    // Phenom People career sites (careers.{company}.com) expose a JSON data API at
    // /widgets. Posting a body with ddoKey "refineSearch" returns the job list with
    // full location and posted date. The api: URL in portals.yml is that endpoint:
    //   https://careers.united.com/widgets
    //
    // The request needs per-site values (pageId, locale, country, baseUrl) that live in
    // a `var phApp = {...}` blob on the careers page, so fetchAll reads that first
    // rather than hardcoding them — pageId differs per site (page13 vs page19) and
    // changes when a site is rebuilt.
    //
    // Job URL: {baseUrl}job/{jobId}/{title-slug}
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
      const timeoutMs = opts?.timeoutMs || 10_000;
      let host;
      try { host = new URL(url).host; } catch { return { _jobs: [], _base: '' }; }

      // Read phApp config off whichever landing path the site serves it from.
      let cfg = null;
      for (const p of ['/us/en', '/', '/en']) {
        try {
          const r = await fetch(`https://${host}${p}`, {
            headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
          });
          if (!r.ok) continue;
          const html = await r.text();
          const i = html.indexOf('var phApp');
          if (i < 0) continue;
          const tail = html.slice(i, i + 8000);
          const objStr = tail.slice(tail.indexOf('{'));
          let depth = 0, end = 0;
          for (let k = 0; k < objStr.length; k++) {
            if (objStr[k] === '{') depth++;
            else if (objStr[k] === '}' && --depth === 0) { end = k + 1; break; }
          }
          try { cfg = JSON.parse(objStr.slice(0, end)); } catch { /* try next path */ }
          if (cfg) break;
        } catch { /* try next path */ }
      }
      if (!cfg) return { _jobs: [], _base: '' };

      const base = cfg.baseUrl || `https://${host}/`;
      const all = [];
      const SIZE = 50;
      // 4 pages = 200 jobs, newest-first; these boards run in the low hundreds.
      for (let page = 0; page < 4; page++) {
        const body = {
          lang: cfg.locale || 'en_us', deviceType: 'desktop', country: cfg.country || 'us',
          pageName: 'search-results', ddoKey: 'refineSearch', sortBy: '', subsearch: '',
          from: page * SIZE, jobs: true, counts: true,
          all_fields: ['category', 'country', 'state', 'city'], size: SIZE, clearAll: false,
          jdsource: 'facets', isSliderEnable: false, pageId: cfg.pageId || 'page1',
          siteType: cfg.siteType || 'external', keywords: '', global: true,
        };
        let json;
        try {
          const r = await fetch(cfg.widgetApiEndpoint || `https://${host}/widgets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': base },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!r.ok) break;
          json = await r.json();
        } catch { break; }
        const jobs = json?.refineSearch?.data?.jobs || [];
        all.push(...jobs);
        if (jobs.length < SIZE || all.length >= (json?.refineSearch?.totalHits ?? 0)) break;
      }
      return { _jobs: all, _base: base };
    },
    parse(json, company) {
      const { _jobs: jobs = [], _base: base = '' } = json || {};
      return jobs.map(j => ({
        company,
        role:     j.title || '',
        // Title slug: the site accepts any slug, but match its own dash-joined form.
        link:     `${base}job/${j.jobId}/${String(j.title || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        // `location` is already "City, State, Country" — what isUS() wants.
        location: j.location || j.cityStateCountry || j.cityState || '',
        posted:   toDate(j.postedDate || j.dateCreated),
      }));
    },
    parseLink(host, path) {
      const m = path.match(/^(?:\/[a-z]{2}\/[a-z]{2})?\/job\/([A-Za-z0-9-]+)\//);
      return m ? { type: 'phenom', host, id: m[1] } : null;
    },
  },

  saicjobs: {
    // SAIC uses Jobvite/Talemetry at jobs.saic.com with a public JSON search API.
    // URL pattern: /search/jobs?format=json&per_page=50&page=N
    // Job link: https://jobs.saic.com/jobs/{id}-{permalink}
    boardApi: url => url,
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        let json;
        try { json = await fetchJson(`${url}&page=${page}`, opts); } catch { break; }
        const entries = (json.entries || []).filter(e => e.location?.country === 'United States');
        all.push(...entries);
        if ((json.entries || []).length < 50) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     `https://jobs.saic.com/jobs/${j.id}-${j.permalink}`,
        location: j.location?.locality && j.location?.region_abbr
          ? `${j.location.locality}, ${j.location.region_abbr}`
          : (j.location?.name || 'United States'),
        posted:   '',
      }));
    },
    parseLink(host, path) {
      if (host !== 'jobs.saic.com') return null;
      const m = path.match(/\/jobs\/(\d+)-/);
      return m ? { type: 'saicjobs', id: m[1] } : null;
    },
  },

  bainrss: {
    // Bain & Company uses a Lumesse/TalentLink ATS exposing an RSS feed per country.
    // RSS items have title (CDATA) + link (GUID). No location field — feed is US-filtered.
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const seen = new Set();
      for (let offset = 0; offset <= 300; offset += 20) {
        const feedUrl = `${url}&folderOffset=${offset}`;
        let text;
        try { text = await fetchText(feedUrl, opts); } catch { break; }
        const items = [...text.matchAll(/<item>([\s\S]+?)<\/item>/g)].map(m=>m[1]);
        if (!items.length) break;
        let newCount = 0;
        for (const item of items) {
          const title = item.match(/<title>(?:<!\[CDATA\[)?([^\]<]{5,150})(?:\]\]>)?<\/title>/)?.[1]?.trim();
          const link = item.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]?.trim() ||
                       item.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
          const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim();
          if (!link || seen.has(link)) continue;
          seen.add(link);
          all.push({ title, link, pubDate });
          newCount++;
        }
        if (newCount === 0) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     j.link || '',
        location: 'United States',   // feed is pre-filtered to US
        posted:   toDate(j.pubDate),
      }));
    },
    parseLink(host, path) {
      if (host !== 'careers.bain.com') return null;
      const m = path.match(/\/FolderDetail\/[^/]+\/(\d+)/);
      return m ? { type: 'bainrss', id: m[1] } : null;
    },
  },

  schwabicims: {
    // Charles Schwab posts via iCIMS, surfaced through schwabjobs.com (TalentBrew frontend).
    // The iCIMS search page renders job blocks as server-side HTML — no JS required.
    // Job URL pattern: career-schwab.icims.com/jobs/{id}/{slug}/job
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      let html;
      try { html = await fetchText(url, opts); } catch { return { jobs: [] }; }
      const re = /field-label">Job Locations<\/span>\s*<span[^>]*>\s*([^<]+)<\/span>[\s\S]{0,400}?href="(https:\/\/career-schwab\.icims\.com\/jobs\/(\d+)\/([^"]+)\/job[^"]*)"/g;
      const jobs = [];
      const seen = new Set();
      let m;
      while ((m = re.exec(html)) !== null) {
        if (seen.has(m[3])) continue;
        seen.add(m[3]);
        jobs.push({ rawLoc: m[1].trim(), link: m[2].replace('?in_iframe=1',''), id: m[3], rawSlug: m[4] });
      }
      return { jobs };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        const title = decodeURIComponent(j.rawSlug.replace(/%2c/gi,',')).replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
        const firstLoc = j.rawLoc.split('|')[0].trim();
        const parts = firstLoc.split('-');
        const country = parts[0], state = parts[1]||'', city = parts.slice(2).join(' ');
        const location = country==='US' ? (city ? `${city}, ${state}` : `${state}, USA`) : firstLoc;
        return { company, role: title, link: j.link, location, posted: '' };
      });
    },
    parseLink(host, path) {
      if (host !== 'career-schwab.icims.com') return null;
      const m = path.match(/\/jobs\/(\d+)/);
      return m ? { type: 'schwabicims', id: m[1] } : null;
    },
  },

  icims: {
    // Generic iCIMS HTML scrape. Works for companies on `careers-{slug}.icims.com`
    // whose /jobs/search page renders job blocks server-side (most iCIMS portals).
    // The api: URL in portals.yml should be the base search page, e.g.:
    //   https://careers-peraton.icims.com/jobs/search?ss=1&searchKeyword=&in_iframe=1
    // The adapter paginates via &pr=N (0-indexed, 25 jobs/page) up to 20 pages.
    //
    // Job URL pattern: careers-{slug}.icims.com/jobs/{id}/{slug}/job?in_iframe=1
    // Location format: US-STATE-City | Country (multi-location pipe-separated)
    // Posted date: <span title="M/D/YYYY H:MM AM/PM">
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const seen = new Set();
      // Find anchors → captures (offset, link, id, title)
      const anchorRe = /<a href="(https:\/\/careers-[^.]+\.icims\.com\/jobs\/(\d+)\/[^"]+\/job[^"]*)"[^>]*title="\d+ - ([^"]+)"/g;
      const locRe = /field-label">Job Locations<\/span>\s*<span[^>]*>\s*([^<]+)<\/span>/;
      const dateRe = /<span title="(\d+\/\d+\/\d+)[^"]*">/;
      for (let page = 0; page < 20; page++) {
        const pageUrl = url.includes('pr=') ? url.replace(/pr=\d+/, `pr=${page}`) : `${url}${url.includes('?') ? '&' : '?'}pr=${page}`;
        let html;
        try { html = await fetchText(pageUrl, opts); } catch { break; }
        // Collect all anchors with positions
        const anchors = [...html.matchAll(anchorRe)];
        if (anchors.length === 0) break;
        let pageNew = 0;
        for (let i = 0; i < anchors.length; i++) {
          const m = anchors[i];
          const id = m[2];
          if (seen.has(id)) continue;
          seen.add(id);
          // Block = from previous anchor up to this anchor (location/date appear BEFORE the title in same row)
          const start = i > 0 ? anchors[i-1].index : Math.max(0, m.index - 8000);
          const end = m.index;
          const block = html.slice(start, end);
          const locMatch = block.match(locRe);
          const dateMatch = block.match(dateRe);
          all.push({
            id,
            link: m[1].replace('?in_iframe=1', ''),
            title: m[3],
            posted: dateMatch?.[1] || '',
            rawLoc: locMatch?.[1].trim() || '',
          });
          pageNew++;
        }
        if (pageNew === 0) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        // Convert "5/13/2026" → "2026-05-13"
        let posted = '';
        const dm = j.posted?.match(/^(\d+)\/(\d+)\/(\d{4})/);
        if (dm) posted = `${dm[3]}-${dm[1].padStart(2,'0')}-${dm[2].padStart(2,'0')}`;
        // Parse multi-location ("US-VA-Chantilly | US-FL-MacDill AFB" → "Chantilly, VA")
        const firstLoc = (j.rawLoc || '').split('|')[0].trim();
        let location;
        if (!firstLoc) {
          location = '';
        } else {
          const parts = firstLoc.split('-');
          if (parts[0] === 'US') {
            const city = parts.slice(2).join(' ').trim();
            const state = parts[1] || '';
            location = city && state ? `${city}, ${state}` : (state || 'USA');
          } else {
            location = firstLoc;
          }
        }
        // Decode HTML entities in title
        const role = j.title.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
        return { company, role, link: j.link, location, posted };
      });
    },
    parseLink(host, path) {
      if (!host.endsWith('.icims.com')) return null;
      const m = path.match(/\/jobs\/(\d+)/);
      return m ? { type: 'icims', id: m[1] } : null;
    },
  },

  atlassian: {
    // Atlassian uses iCIMS via Jibe at join.atlassian.com with a public JSON API.
    // country=United+States narrows to ~176 US jobs; API caps at 10/page → ~18 pages.
    boardApi: url => url,
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const seen = new Set();
      for (let page = 1; page <= 20; page++) {
        let json;
        try { json = await _fetchJson(`${url}&page=${page}`, opts); } catch { break; }
        const jobs = (json.jobs || []).map(j => j.data).filter(Boolean);
        let pageNew = 0;
        for (const j of jobs) {
          if (seen.has(j.req_id)) continue;
          seen.add(j.req_id);
          all.push(j);
          pageNew++;
        }
        if (jobs.length < 10 || pageNew === 0) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        const desc = `${j.description || ''} ${j.qualifications || ''} ${j.responsibilities || ''}`
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        // Use apply_url (strip /login suffix) as the canonical link when present;
        // fall back to Atlassian-specific path for the original implementation.
        const link = j.apply_url
          ? j.apply_url.replace(/\/login(\?.*)?$/, '')
          : `https://join.atlassian.com/atlassian-talent-community/jobs/${j.req_id}?lang=en-us`;
        return {
          company,
          role:        j.title || '',
          link,
          location:    j.short_location || j.location_name || '',
          posted:      toDate(j.posted_date),
          description: desc,
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'join.atlassian.com' && !host.includes('.icims.com')) return null;
      const m = path.match(/\/jobs\/(\d+)/);
      return m ? { type: 'atlassian', id: m[1] } : null;
    },
  },

  plaidcareers: {
    // Plaid hosts its own careers page with jobs embedded as /careers/openings/{dept}/{loc}/{slug}/.
    // No external ATS — parse the listing HTML directly. Locations are URL segments ("california",
    // "new-york-city-office", "gbr-lon-office") — filter non-US by segment keyword matching.
    boardApi: url => url,
    NON_US_SEGS: new Set(['gbr','lon','london','uk','europe','canada','india','international','remote-international','apac','emea','latam','mexico']),
    async fetchAll(url, _fetchJson, opts) {
      let html;
      try { html = await fetchText(url, opts); } catch { return { jobs: [] }; }
      const re = /href="(\/careers\/openings\/([^/]+)\/([^/]+)\/([^/"]+)\/)"/g;
      const jobs = []; const seen = new Set();
      let m;
      while ((m = re.exec(html)) !== null) {
        const [, path, , locSeg, slug] = m;
        if (seen.has(path)) continue;
        seen.add(path);
        jobs.push({ path, locSeg, slug });
      }
      return { jobs };
    },
    parse(json, company) {
      const NON_US = new Set(['gbr','lon','london','uk','europe','canada','india','international','remote-international','apac','emea','latam','mexico']);
      return (json.jobs || []).map(j => {
        const title = j.slug.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
        // Flag non-US by checking segments against keywords
        const locLower = j.locSeg.toLowerCase();
        const isNonUS = NON_US.has(locLower) || [...NON_US].some(k => locLower.includes(k));
        const location = isNonUS ? j.locSeg : 'United States';
        return {
          company,
          role:     title,
          link:     `https://plaid.com${j.path}`,
          location,
          posted:   '',
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'plaid.com' && host !== 'www.plaid.com') return null;
      const m = path.match(/\/careers\/openings\/[^/]+\/[^/]+\/([^/]+)\//);
      return m ? { type: 'plaidcareers', id: m[1] } : null;
    },
  },

  applecareers: {
    // Scrape jobs.apple.com search HTML. Each result has title, team, posted date, and city
    // inline. URL must use ?location=united-states-USA to constrain to US postings.
    boardApi: url => url,
    jobApi:   (_slug, id) => `https://jobs.apple.com/en-us/details/${id}`,
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const seen = new Set();
      const sep = url.includes('?') ? '&' : '?';
      const re = /href="\/en-us\/details\/(\d+-\d+)\/[a-z0-9-]+\?[^"]*"[^>]*data-discover="true">([^<]+)<\/a><\/h3>[\s\S]*?team-name[^>]*>([^<]+)<\/span>[\s\S]*?job-posted-date[^>]*>([^<]+)<\/span>[\s\S]{0,500}?store-name-container[^>]*>([^<]+)<\/span>/g;
      const decode = s => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
      for (let page = 1; page <= 8; page++) {
        let html;
        try { html = await fetchText(`${url}${sep}page=${page}`, opts); } catch { break; }
        let m;
        let pageNew = 0;
        while ((m = re.exec(html)) !== null) {
          const [, id, title, , posted, city] = m;
          if (seen.has(id)) continue;
          seen.add(id);
          all.push({ id, title: decode(title.trim()), posted, city: city.trim() });
          pageNew++;
        }
        re.lastIndex = 0;
        if (pageNew === 0) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     `https://jobs.apple.com/en-us/details/${j.id}`,
        // Append USA so isUS() passes for city-only strings like "Cupertino"
        location: j.city ? `${j.city}, USA` : 'United States',
        posted:   toDate(j.posted),
      }));
    },
    parseLink(host, path) {
      if (host !== 'jobs.apple.com') return null;
      const m = path.match(/\/details\/(\d+-\d+)/);
      return m ? { type: 'applecareers', id: m[1] } : null;
    },
  },

  googlecareers: {
    // Scrape Google's careers HTML — they don't expose a public JSON API.
    // The listing page renders job links and aria-label titles in plain HTML.
    // Location is implied by the location=United+States query param; posted date is
    // unavailable, but jobs.mjs treats empty `posted` as "passes recency filter".
    boardApi: url => url,
    jobApi:   (_slug, id) => `https://www.google.com/about/careers/applications/jobs/results/${id}`,
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const seen = new Set();
      const sep = url.includes('?') ? '&' : '?';
      for (let page = 1; page <= 8; page++) {
        let html;
        try { html = await fetchText(`${url}${sep}page=${page}`, opts); } catch { break; }
        const matches = [...html.matchAll(/jobs\/results\/(\d+)-[a-z0-9-]+[^"]*"[^<]*aria-label="Learn more about ([^"]+)"/g)];
        if (!matches.length) break;
        let pageNew = 0;
        for (const m of matches) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          all.push({ id: m[1], title: m[2] });
          pageNew++;
        }
        if (pageNew === 0) break;   // page returned only IDs we'd already seen → end of results
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     `https://www.google.com/about/careers/applications/jobs/results/${j.id}`,
        location: 'United States',   // implied by query param; needed for isUS() to pass
        posted:   '',                // not exposed by Google; jobs.mjs treats empty as pass-recency
      }));
    },
    parseLink(host, path) {
      if (host !== 'www.google.com' && host !== 'google.com') return null;
      const m = path.match(/\/about\/careers\/applications\/jobs\/results\/(\d+)/);
      return m ? { type: 'googlecareers', id: m[1] } : null;
    },
  },

  amazon: {
    // amazon.jobs has no per-board concept — one endpoint covers all US postings.
    // base_query is a phrase match, not OR-of-terms ("new grad" and "graduate software"
    // both return 0 hits), so no single query reaches the university/new-grad feed:
    // paginating base_query=engineer 1500 deep surfaces zero grad postings, while
    // base_query=2027 alone returns 72. The result sets barely overlap, so fetchAll
    // sweeps each term separately and dedupes on icims id.
    boardApi: () => 'https://www.amazon.jobs/en/search.json?base_query=engineer&country=USA&result_limit=100&sort=recent',
    jobApi:   (_slug, id) => `https://www.amazon.jobs/en/jobs/${id}`,
    async fetchAll(url, fetchJson, opts) {
      const seen = new Set();
      const all  = [];
      for (const term of AMAZON_QUERIES) {
        for (let page = 0; page < 5; page++) {
          const u = new URL(url);
          u.searchParams.set('base_query', term);
          u.searchParams.set('offset', String(page * 100));
          const json = await fetchJson(u.toString(), opts);
          const jobs = json.jobs || [];
          for (const j of jobs) {
            const key = j.id_icims || j.id || j.job_path;
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            all.push(j);
          }
          if (jobs.length < 100) break;
        }
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        const parts = [j.city, j.state].filter(Boolean);
        const location = parts.length ? parts.join(', ') : (j.country_code || '');
        const html = `${j.description || ''} ${j.basic_qualifications || ''} ${j.preferred_qualifications || ''}`;
        const description = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        return {
          company,
          role:        j.title || '',
          link:        `https://www.amazon.jobs${j.job_path || ''}`,
          location,
          posted:      toDate(j.posted_date),
          description,
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'www.amazon.jobs' && host !== 'amazon.jobs') return null;
      const m = path.match(/\/jobs\/(\d+)/);
      return m ? { type: 'amazon', id: m[1] } : null;
    },
  },

  oraclecloud: {
    // Oracle Cloud HCM (used by JPMC, AT&T, etc). GET-based JSON API.
    // The api URL in portals.yml is the full requisitionList query (with finder, expand, etc).
    // fetchAll injects offset for pagination (5 pages × 200 = 1000 jobs).
    boardApi: url => url,
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      for (let page = 0; page < 5; page++) {
        const offset = page * 200;
        // Strip any existing offset= inside the finder query, then append fresh one.
        const paged = url.replace(/,offset=\d+/, '') + `,offset=${offset}`;
        let json;
        try { json = await fetchJson(paged, opts); } catch { break; }
        const items = (json.items || []).flatMap(it => it.requisitionList || []);
        all.push(...items);
        if (items.length < 200) break;
      }
      const u = new URL(url);
      const site = (url.match(/siteNumber=([^,&]+)/) || [])[1] || 'CX_1';
      return { items: all, _info: { host: u.hostname, site } };
    },
    parse(json, company) {
      const info = json._info;
      return (json.items || []).map(j => {
        const desc = `${j.ShortDescriptionStr || ''} ${j.ExternalQualificationsStr || ''} ${j.ExternalResponsibilitiesStr || ''}`
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        return {
          company,
          role:        j.Title || '',
          link:        info ? `https://${info.host}/hcmUI/CandidateExperience/en/sites/${info.site}/job/${j.Id}` : '',
          location:    j.PrimaryLocation || '',
          posted:      toDate(j.PostedDate),
          description: desc,
        };
      });
    },
    // No reliable individual-job liveness endpoint — let prune treat as generic (skipped for scan rows).
    parseLink: () => null,
  },

  workday: {
    // Workday's listing API is POST with a JSON body. The api URL in portals.yml can be either:
    //   public board URL: https://{tenant}.wd{N}.myworkdayjobs.com/{site}
    //   API URL:          https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
    // Both are normalized here. The "boardApi" return is passed through; fetchAll does the POST.
    boardApi: url => url,
    jobApi:   (info, path) => `https://${info.host}/wday/cxs/${info.tenant}/${info.site}/job${path}`,
    async fetchAll(url, fetchJson, opts) {
      const info = parseWorkdayUrl(url);
      if (!info) return { jobPostings: [], _info: null };
      const endpoint = `https://${info.host}/wday/cxs/${info.tenant}/${info.site}/jobs`;
      const all = [];
      // Workday caps limit at ~20. 5 pages = 100 jobs, recent-first.
      for (let page = 0; page < 5; page++) {
        let json;
        try {
          json = await postJson(endpoint, { appliedFacets: {}, limit: 20, offset: page * 20, searchText: '' }, opts);
        } catch { break; }
        const jobs = json.jobPostings || [];
        all.push(...jobs);
        if (jobs.length < 20) break;
      }
      await resolveWorkdayMultiLocations(all, info, fetchJson, opts);
      return { jobPostings: all, _info: info };
    },
    parse(json, company) {
      const info = json._info;
      return (json.jobPostings || []).map(j => ({
        company,
        role:     j.title || '',
        link:     info ? `https://${info.host}/${info.site}${j.externalPath || ''}` : '',
        location: workdayLocation(j),
        posted:   workdayPostedToDate(j.postedOn),
      }));
    },
    parseLink(host, path) {
      if (!/\.myworkdayjobs\.com$/.test(host)) return null;
      // Public URL pattern: /{site}/job/{loc}/{slug}_{reqid}-{n}
      const m = path.match(/^\/([^/]+)\/job\/(.+)/);
      if (!m) return null;
      const tenant = host.split('.')[0];
      return { type: 'workday', info: { host, tenant, site: m[1] }, externalPath: `/job/${m[2]}` };
    },
  },

  uber: {
    // Uber's in-house careers API. POST search; requires literal `x-csrf-token: x` header.
    // limit accepts large values (300+), so one request covers all US postings.
    boardApi: () => 'https://www.uber.com/api/loadSearchJobsResults?localeCode=en',
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const limit = 300;
      for (let page = 0; page < 20; page++) {
        const json = await postJson(url, {
          params: { location: [{ country: 'USA' }] }, limit, page,
        }, { ...opts, headers: { 'x-csrf-token': 'x' } });
        const batch = json?.data?.results || [];
        all.push(...batch);
        if (batch.length < limit) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:        j.title || '',
        link:        `https://www.uber.com/global/en/careers/list/${j.id}/`,
        location:    [j.location?.city, j.location?.region, j.location?.countryName].filter(Boolean).join(', '),
        posted:      toDate(j.creationDate),
        description: cleanDescription(j.description || ''),
      }));
    },
    parseLink(host, path) {
      if (!/(^|\.)uber\.com$/.test(host)) return null;
      const m = path.match(/\/careers\/list\/(\d+)/);
      return m ? { type: 'uber', id: m[1] } : null;
    },
  },

  githubcareers: {
    // GitHub's careers site (iCIMS Attract at github.careers). Plain GET, 10 jobs/page.
    // No posted date in the payload — recency filter passes these through.
    boardApi: () => 'https://www.github.careers/api/jobs',
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      for (let page = 1; page <= 30; page++) {
        const json = await fetchJson(`${url}?page=${page}`, opts);
        const batch = (json?.jobs || []).map(j => j.data).filter(Boolean);
        all.push(...batch);
        if (batch.length === 0 || all.length >= (json?.totalCount ?? Infinity)) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:        j.title || '',
        link:        `https://www.github.careers/careers-home/jobs/${j.slug}?lang=${j.language || 'en-us'}`,
        location:    [j.location_name, j.country].filter(Boolean).join(', '),
        posted:      '',
        description: cleanDescription([j.description, j.qualifications, j.responsibilities].filter(Boolean).join('\n')),
      }));
    },
    parseLink(host, path) {
      if (host !== 'www.github.careers' && host !== 'github.careers') return null;
      const m = path.match(/\/careers-home\/jobs\/(\d+)/);
      return m ? { type: 'githubcareers', id: m[1] } : null;
    },
  },

  tiktok: {
    // ByteDance's in-house ATS behind lifeattiktok.com. Public POST search endpoint;
    // the `website-path: tiktok` header is required (400 without it). Descriptions are
    // inline (description + requirement). No posted date — recency filter passes these.
    boardApi: () => 'https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts',
    async fetchAll(url, _fetchJson, opts) {
      const all = [];
      const limit = 1000;
      for (let offset = 0; offset < 20_000; offset += limit) {
        const json = await postJson(url, {
          keyword: '', limit, offset,
          job_category_id_list: [], location_code_list: [], subject_id_list: [], recruitment_id_list: [],
        }, { ...opts, headers: { 'website-path': 'tiktok' } });
        const batch = json?.data?.job_post_list || [];
        all.push(...batch);
        if (batch.length < limit) break;
      }
      return { jobs: all };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => {
        // city_info is a chain: city → state → country; join en_names so isUS() can match.
        const locParts = [];
        for (let n = j.city_info; n; n = n.parent) locParts.push(n.en_name);
        return {
          company,
          role:        j.title || '',
          link:        `https://lifeattiktok.com/search/${j.id}`,
          location:    [...new Set(locParts.filter(Boolean))].join(', '),
          posted:      '',
          description: cleanDescription([j.description, j.requirement].filter(Boolean).join('\n')),
        };
      });
    },
    parseLink(host, path) {
      if (host !== 'lifeattiktok.com') return null;
      const m = path.match(/^\/search\/(\d+)/);
      return m ? { type: 'tiktok', id: m[1] } : null;
    },
  },

  metacareers: {
    // Meta's careers site (metacareers.com). Relay GraphQL endpoint — needs an LSD token
    // scraped from the jobsearch page, form-encoded POST with a persisted-query doc_id.
    // The doc_id is stable for long stretches but rotates on Relay schema pushes; if the
    // adapter starts returning errors/empty with HTTP 200, re-extract it from the
    // CareersJobSearchResultsDataQuery_candidate_portalRelayOperation module in the
    // page's JS bundles. No posted date or descriptions in the payload.
    boardApi: () => 'https://www.metacareers.com/graphql',
    async fetchAll(url, _fetchJson, opts) {
      const html = await fetchText('https://www.metacareers.com/jobsearch/', opts);
      const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
      if (!lsd) throw new Error('metacareers: LSD token not found on jobsearch page');
      const variables = {
        search_input: {
          q: null, divisions: [], offices: [], roles: [], leadership_levels: [],
          saved_jobs: [], saved_searches: [], sub_teams: [], teams: [],
          is_leadership: false, is_remote_only: false, sort_by_new: true, results_per_page: null,
        },
        isLoggedIn: false, viewasUserID: null,
      };
      const body = new URLSearchParams({
        lsd, doc_id: '27506805582236862', variables: JSON.stringify(variables),
      });
      const res = await fetchWithTimeout(url, opts?.timeoutMs ?? 30_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-fb-lsd': lsd },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse((await res.text()).replace(/^for \(;;\);/, ''));
      const result = json?.data?.job_search_with_featured_jobs;
      if (!result) throw new Error('metacareers: unexpected GraphQL response shape (doc_id may have rotated)');
      return { jobs: result.all_jobs || [] };
    },
    parse(json, company) {
      return (json.jobs || []).map(j => ({
        company,
        role:     j.title || '',
        link:     `https://www.metacareers.com/jobs/${j.id}/`,
        location: (j.locations || []).join('; '),
        posted:   '',
      }));
    },
    parseLink(host, path) {
      if (!/(^|\.)metacareers\.com$/.test(host)) return null;
      const m = path.match(/^\/jobs\/(\d+)/);
      return m ? { type: 'metacareers', id: m[1] } : null;
    },
  },

  simplify: {
    // SimplifyJobs community feeds (New-Grad-Positions / Summer2026-Internships GitHub
    // repos). One "company" entry in portals.yml fans out to every company in the feed —
    // parse() sets each job's real company_name, which jobs.mjs preserves. Listings carry
    // epoch date_posted, so the daily recency filter keeps volume manageable. URLs are
    // direct ATS links; utm_* params are stripped so dedup matches scanner-sourced links.
    boardApi: url => url,
    parse(json, _company) {
      const list = Array.isArray(json) ? json : [];
      return list.filter(j => j.active && j.is_visible !== false).map(j => {
        let link = j.url || '';
        try {
          const u = new URL(link);
          for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
          link = u.toString().replace(/\?$/, '');
        } catch { /* keep raw link */ }
        return {
          company:  j.company_name || 'Unknown',
          role:     j.title || '',
          link,
          location: (j.locations || []).join('; '),
          posted:   j.date_posted ? new Date(j.date_posted * 1000).toISOString().slice(0, 10) : '',
        };
      });
    },
    parseLink() { return null; },   // feed links point at foreign ATS hosts; global parseLink handles them
    // Feed has no descriptions. Links are direct ATS URLs, so detect the ATS via the
    // global parseLink and fetch the posting through that ATS's public API. Covers
    // Greenhouse / SmartRecruiters / Lever; other hosts (Workday, custom) return ''.
    async fetchDescription(job, fetchJson, opts) {
      const p = parseLink(job.link);
      if (!p || !p.slug || !p.id) return '';
      try {
        if (p.type === 'greenhouse' || p.type === 'smartrecruiters') {
          return await ATS[p.type].fetchDescription({ _slug: p.slug, _id: p.id }, fetchJson, opts);
        }
        if (p.type === 'lever') {
          const json = await fetchJson(ATS.lever.jobApi(p.slug, p.id), opts);
          return cleanDescription(json.descriptionPlain || json.description || '');
        }
      } catch { /* fall through */ }
      return '';
    },
  },

  smartrecruiters: {
    boardApi: slug => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&status=PUBLIC`,
    jobApi:   (slug, id) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`,
    // The postings API caps a single response at 100. Without paging we saw only
    // the first 100 of e.g. Dominos' 24,659 or ServiceNow's 568 postings, so most
    // boards were silently truncated. `totalFound` tells us when to stop.
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      const base = url.replace(/[?&]offset=\d+/, '');
      const sep = base.includes('?') ? '&' : '?';
      for (let offset = 0; offset < SR_MAX_POSTINGS; offset += SR_PAGE_SIZE) {
        let json;
        try { json = await fetchJson(`${base}${sep}offset=${offset}`, opts); } catch { break; }
        const page = json.content || [];
        all.push(...page);
        // Short page means the board is exhausted; totalFound bounds the rest.
        if (page.length < SR_PAGE_SIZE) break;
        if (json.totalFound && all.length >= json.totalFound) break;
      }
      return { content: all };
    },
    parse(json, company) {
      return (json.content || []).map(j => {
        const loc = j.location;
        const parts = loc ? [loc.city, loc.region, loc.country].filter(Boolean) : [];
        // If city/region/country are absent, fall back to countryCode so isUS() can reject it
        const location = parts.length > 0 ? parts.join(', ') : (loc?.countryCode || '');
        return {
          company,
          role:     j.name || '',
          link:     `https://jobs.smartrecruiters.com/${j.company?.identifier || ''}/${j.id}`,
          location,
          posted:   toDate(j.releasedDate || j.updatedAt),
          _slug:    j.company?.identifier || '',   // for fetchDescription
          _id:      String(j.id || ''),
        };
      });
    },
    // https://jobs.smartrecruiters.com/{Company}/{postingId}-{slugged-title}
    parseLink(host, path) {
      if (host !== 'jobs.smartrecruiters.com') return null;
      const m = path.match(/^\/([^/]+)\/(\d{10,})(?:-|$)/);
      if (!m) return null;
      return { type: 'smartrecruiters', slug: m[1].toLowerCase(), id: m[2] };
    },
    // SR list API omits descriptions — fetch the individual posting's jobAd sections.
    async fetchDescription(job, fetchJson, opts) {
      if (!job._slug || !job._id) return '';
      try {
        const json = await fetchJson(ATS.smartrecruiters.jobApi(job._slug, job._id), opts);
        const s = json.jobAd?.sections || {};
        const combined = [s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text]
          .filter(Boolean).join(' ');
        return cleanDescription(combined);
      } catch { return ''; }
    },
  },
};

// Detect ATS type from a portals.yml company entry (api field or careers_url).
// Returns { type, url } or null if no API can be inferred.
export function detectApi(company) {
  if (company.api?.includes('greenhouse'))         return { type: 'greenhouse',      url: company.api };
  if (company.api?.includes('ashbyhq.com'))        return { type: 'ashby',           url: company.api };
  if (company.api?.includes('lever.co'))           return { type: 'lever',           url: company.api };
  if (company.api?.includes('smartrecruiters.com'))return { type: 'smartrecruiters', url: company.api };
  if (company.api?.includes('amazon.jobs'))        return { type: 'amazon',          url: company.api };
  if (company.api?.includes('google.com/about/careers')) return { type: 'googlecareers',  url: company.api };
  if (company.api?.includes('jobs.apple.com'))     return { type: 'applecareers',    url: company.api };
  if (company.api?.includes('plaid.com/careers'))  return { type: 'plaidcareers',    url: company.api };
  if (company.api?.includes('join.atlassian.com') || company.api?.includes('/api/jobs?country=')) return { type: 'atlassian', url: company.api };
  if (company.api?.includes('career-schwab.icims.com')) return { type: 'schwabicims', url: company.api };
  if (company.api?.includes('.icims.com'))              return { type: 'icims',       url: company.api };
  if (company.api?.includes('apply.workable.com'))      return { type: 'workable',    url: company.api };
  if (company.api?.includes('.breezy.hr'))              return { type: 'breezy',      url: company.api };
  if (company.api?.includes('jobs.deel.com'))           return { type: 'deel',        url: company.api };
  if (company.api?.includes('api.rippling.com'))        return { type: 'rippling',    url: company.api };
  if (company.api?.includes('.bamboohr.com'))           return { type: 'bamboohr',    url: company.api };
  if (company.api?.includes('jobs.gem.com'))            return { type: 'gem',         url: company.api };
  if (company.api?.includes('/search-jobs/results'))    return { type: 'radancy',     url: company.api };
  if (company.api?.includes('.eightfold.ai'))           return { type: 'eightfold',   url: company.api };
  if (/\/widgets$/.test(company.api || ''))             return { type: 'phenom',      url: company.api };
  if (company.api?.includes('jobs.saic.com'))           return { type: 'saicjobs',    url: company.api };
  if (company.api?.includes('careers.bain.com'))        return { type: 'bainrss',     url: company.api };
  if (company.api?.includes('api.lifeattiktok.com')) return { type: 'tiktok',        url: company.api };
  if (company.api?.includes('metacareers.com/graphql')) return { type: 'metacareers', url: company.api };
  if (company.api?.includes('githubusercontent.com/SimplifyJobs')) return { type: 'simplify', url: company.api };
  if (company.api?.includes('uber.com/api/loadSearchJobsResults')) return { type: 'uber', url: company.api };
  if (company.api?.includes('github.careers'))     return { type: 'githubcareers',   url: company.api };
  if (company.api?.includes('myworkdayjobs.com'))  return { type: 'workday',         url: company.api };
  if (company.api?.includes('oraclecloud.com'))    return { type: 'oraclecloud',     url: company.api };

  const wd = (company.careers_url || '').match(/\.myworkdayjobs\.com/);
  if (wd && !company.api) return { type: 'workday', url: company.careers_url };

  const url = company.careers_url || '';
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby) return { type: 'ashby', url: ATS.ashby.boardApi(ashby[1]) };
  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever) return { type: 'lever', url: ATS.lever.boardApi(lever[1]) };
  const gh = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (gh && !company.api) return { type: 'greenhouse', url: ATS.greenhouse.boardApi(gh[1]) };

  return null;
}

// Extract the GH board slug from a boardApi URL (e.g. /v1/boards/stripe/jobs → "stripe")
export function extractGHSlug(apiUrl) {
  return (apiUrl.match(/\/boards\/([^/]+)/) || [])[1] || '';
}

// Dispatch JSON parsing to the correct ATS. GH needs the board slug from apiUrl.
export function parseJobs(type, json, company, apiUrl = '') {
  if (type === 'greenhouse') {
    return ATS.greenhouse.parse(json, company, extractGHSlug(apiUrl));
  }
  return ATS[type].parse(json, company);
}

// Parse a job URL into { type, slug, id } or { type: 'generic', url } if no ATS match.
// Returns null if the URL is invalid.
export function parseLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const ats of Object.values(ATS)) {
      const result = ats.parseLink(u.hostname, u.pathname);
      if (result) return result;
    }
    return { type: 'generic', url };
  } catch {
    return null;
  }
}
