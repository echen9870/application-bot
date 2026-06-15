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

import { postJson, fetchText } from './fetch.mjs';

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
        posted:   toDate(j.updated_at),
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
    // amazon.jobs has no per-board concept — single endpoint covers all US engineer postings.
    // base_query=engineer narrows the 10k+ US jobs to ~4k SWE-adjacent; result_limit caps at 100,
    // so fetchAll paginates 5 pages = 500 jobs (~30 days of postings) per scan.
    boardApi: () => 'https://www.amazon.jobs/en/search.json?base_query=engineer&country=USA&result_limit=100&sort=recent',
    jobApi:   (_slug, id) => `https://www.amazon.jobs/en/jobs/${id}`,
    async fetchAll(url, fetchJson, opts) {
      const all = [];
      for (let page = 0; page < 5; page++) {
        const json = await fetchJson(`${url}&offset=${page * 100}`, opts);
        const jobs = json.jobs || [];
        all.push(...jobs);
        if (jobs.length < 100) break;
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
    async fetchAll(url, _fetchJson, opts) {
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
      return { jobPostings: all, _info: info };
    },
    parse(json, company) {
      const info = json._info;
      return (json.jobPostings || []).map(j => ({
        company,
        role:     j.title || '',
        link:     info ? `https://${info.host}/${info.site}${j.externalPath || ''}` : '',
        location: j.locationsText || '',
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

  smartrecruiters: {
    boardApi: slug => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&status=PUBLIC`,
    jobApi:   (slug, id) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`,
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
    parseLink: () => null,   // SR job URLs are not parsed by prune (no liveness check)
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
  if (company.api?.includes('jobs.saic.com'))           return { type: 'saicjobs',    url: company.api };
  if (company.api?.includes('careers.bain.com'))        return { type: 'bainrss',     url: company.api };
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
