/**
 * filters.mjs — Shared job filtering utilities
 *
 * Imported by jobs.mjs and write-potential.mjs so filter logic stays in one place.
 */

export const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy','dc',
]);

const NON_US_COUNTRY = [
  'canada','ontario','toronto','vancouver','montreal','calgary','ottawa','quebec','alberta',
  'united kingdom','uk','germany','france','netherlands','sweden','spain','poland','serbia',
  'japan','australia','india','brazil','singapore','israel','dubai','uae','mexico','argentina',
  'denmark','ireland','finland','norway','switzerland','austria','belgium','portugal','czech',
  'romania','hungary','turkey','south korea','china','taiwan','hong kong','new zealand',
  'south africa','europe','emea','apac','latam','apj','estonia','latvia','lithuania',
  'ukraine','russia','italy','greece',
  // LatAm / APAC / EMEA delivery hubs that were missing — without these, a
  // posting like "San Jose, Costa Rica" fell through to the US city list and
  // matched "san jose".
  'costa rica','dominican republic','colombia','chile','peru','panama','uruguay',
  'ecuador','guatemala','philippines','malaysia','thailand','vietnam','indonesia',
  'egypt','nigeria','kenya','morocco','pakistan','bangladesh','sri lanka',
  'saudi arabia','qatar','bahrain','kuwait','jordan','luxembourg','iceland',
  'slovenia','slovakia','bulgaria','croatia','serbia','cyprus','malta',
];

// Full state names. Workday and several ATSes spell the state out and omit the
// country ("O'Fallon, Missouri"), which the two-letter `, XX` check never sees.
export const US_STATE_NAMES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia',
];

export const NON_US_COUNTRY_CODES = new Set([
  'ca','gb','de','fr','nl','se','es','pl','rs','jp','au','in','br','sg','il',
  'ae','mx','ar','dk','ie','fi','no','ch','at','be','pt','cz','ro','hu','tr',
  'kr','cn','tw','hk','nz','za','ee','lv','lt','ua','ru','it','gr','hr','sk',
]);

export function extractMinYOE(title) {
  if (/new\s*grad|early\s*career|intern|entry[\s-]level|junior|university\s*grad|\b202[5-9]\b/i.test(title)) return 0;
  // Level markers that never spell out "N years" but read as senior in practice:
  // Engineer III+ (344 labeled rows, 0.9% applied vs. 2.7% baseline), "Mid"/
  // "Journeyman"/"Experienced" (72 rows, 0% applied), and the Senior/Principal/
  // Distinguished tiers of the "Member of Technical Staff" ladder (SMTS/PMTS/
  // DMTS). "Engineer II" is left alone — its apply rate matches baseline — and
  // so are bare "MTS"/"LMTS": that tier is ambiguous, and the real entry-level
  // MTS title spells out "Member of Technical Staff" in full (see buildTitleFilter).
  if (/\b(iii|iv|v)\b/i.test(title)
      || /\bmid(?:-level)?\b|\bjourneyman\b|\bexperienced\b/i.test(title)
      || /\b[spd]mts\b/i.test(title)) return 4;
  const m = title.match(/\((\d+)[-–]\d*\s*(?:YOE|yrs?|years?)\)/i)
         || title.match(/(\d+)[-–]\d+\s*(?:YOE|yrs?|years?)/i)
         || title.match(/(\d+)\+\s*(?:YOE|yrs?|years?)/i);
  return m ? parseInt(m[1]) : null;
}

export function extractMinYOEFromDesc(desc) {
  if (!desc) return null;
  const patterns = [
    /(\d+)\+\s*years?\s+(?:of\s+)?(?:experience|professional|work)/,
    /(\d+)\s+or\s+more\s+years?\s+(?:of\s+)?(?:experience|professional|work)/,
    /(?:at\s+least|minimum\s+(?:of\s+)?)\s*(\d+)\s+years?\s+(?:of\s+)?(?:experience|professional|work)/,
    /(\d+)\s*[-–]\s*\d+\s+years?\s+(?:of\s+)?(?:experience|professional|work)/,
    /(\d+)\s+to\s+\d+\s+years?\s+(?:of\s+)?(?:experience|professional|work)/,
    /(\d+)\s+years?\s+(?:of\s+)?(?:experience|professional|work)/,
  ];
  let min = null;
  for (const re of patterns) {
    for (const m of desc.matchAll(new RegExp(re.source, 'g'))) {
      const n = parseInt(m[1]);
      if (!isNaN(n) && (min === null || n < min)) min = n;
    }
  }
  return min;
}

export function yoeLabel(title) {
  const min = extractMinYOE(title);
  if (min === null) return '';
  return min === 0 ? 'New Grad' : `${min}+ YOE`;
}

const US_CITIES = ['new york','san francisco','seattle','boston','chicago',
  'austin','denver','los angeles','atlanta','miami','washington','houston',
  'philadelphia','phoenix','portland','minneapolis','detroit','nashville',
  'raleigh','salt lake','san jose','san diego','pittsburgh','cincinnati'];

// Word-bounded so substrings don't produce false rejects: without \b, 'india'
// matches "Indianapolis"/"Indiana" and 'uk' matches "Milwaukee", silently
// dropping US jobs as non-US.
const NON_US_COUNTRY_RE = new RegExp(`\\b(${NON_US_COUNTRY.join('|')})\\b`);
const US_STATE_NAMES_RE = new RegExp(`\\b(${US_STATE_NAMES.join('|')})\\b`);

export function isUS(location) {
  if (!location || !location.trim()) return true;
  const lc = location.toLowerCase().trim();

  // Unambiguous US signals win over the country blocklist, so a US city that
  // shares a name with a foreign one ("Vancouver, Washington") resolves right.
  if (lc.includes('united states') || /\bus\b/.test(lc)) return true;
  if (US_STATE_NAMES_RE.test(lc)) return true;

  if (NON_US_COUNTRY_RE.test(lc)) return false;
  if (NON_US_COUNTRY_CODES.has(lc)) return false;

  // SmartRecruiters formats location as "City, Region, countryCode", and several
  // country codes are also US state codes — IN is both India and Indiana, so
  // "Bengaluru, KA, in" read as US below. Only trust a trailing code as a country
  // when a third segment precedes it: in the two-part "San Jose, CA" form the
  // trailing code is a US state, and reading that as Canada would drop California.
  const segments = lc.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length >= 3 && NON_US_COUNTRY_CODES.has(segments.at(-1))) return false;

  // Bare two-letter codes are a weak signal — they collide with common words
  // ("...BC, or NS Only" reads 'or' as Oregon), so they rank below the country
  // check rather than above it.
  if ([...lc.matchAll(/,\s*([a-z]{2})\b/g)].some(m => US_STATES.has(m[1]))) return true;
  // "Remote, ie" is an Ireland-remote role, not a US one. Only reject when the
  // trailing code is unambiguously foreign — "Remote, CA" stays US, since CA
  // reads as California far more often than Canada on the boards we scan.
  if (segments.length === 2 && segments[0] === 'remote'
      && NON_US_COUNTRY_CODES.has(segments[1]) && !US_STATES.has(segments[1])) return false;
  if (lc.includes('remote')) return true;
  if (US_CITIES.some(c => lc.includes(c))) return true;
  return false;
}

// Perplexity's real entry-level title is the literal phrase "Member of
// Technical Staff" — the word "Staff" there names the job track, not a
// seniority tier, so the "Staff" negative keyword must not reject it.
const MEMBER_OF_TECHNICAL_STAFF_RE = /\bmember of technical staff\b/i;

// A keyword is safe to wrap in \b...\b when it's plain alnum/space/hyphen with
// no leading/trailing padding. Several entries (`'Sr.'`, `'Sr '`, `'VP '`,
// `'SAP '`, `.NET`) were hand-padded with their own boundary spaces or lead
// with punctuation \b can't anchor against — those keep the historical literal
// substring match instead of being re-wrapped.
const WORD_SAFE_KEYWORD = /^[a-z][a-z0-9 '-]*[a-z0-9]$/;

function keywordMatcher(kw) {
  if (WORD_SAFE_KEYWORD.test(kw)) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return lc => re.test(lc);
  }
  return lc => lc.includes(kw);
}

export function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase()).map(k => ({ kw: k, test: keywordMatcher(k) }));
  const neg = (tf?.negative || []).map(k => k.toLowerCase()).map(k => ({ kw: k, test: keywordMatcher(k) }));
  return t => {
    const lc = t.toLowerCase();
    if (pos.length > 0 && !pos.some(({ test }) => test(lc))) return false;
    for (const { kw, test } of neg) {
      // Without word boundaries "lead" also matched inside "Leadership Track"
      // and "staff" matched the real job-track name above — both are handled
      // now, but "staff" still needs the explicit MTS exemption since the word
      // genuinely appears, just not as a seniority signal.
      if (kw === 'staff' && MEMBER_OF_TECHNICAL_STAFF_RE.test(lc)) continue;
      if (test(lc)) return false;
    }
    return true;
  };
}

// Heuristic check: does this URL look like a specific job posting (not a blog page,
// aggregator listing, or generic careers landing page)?
// Used to filter websearch results without Claude having to inspect each one in-context.
// Conservative: only rejects obvious non-job URLs, accepts ambiguous cases.
const NON_JOB_PATH = /\/(blog|news|press|article|story|podcast|webinar|insights?|guides?|resources?|stories|customers?|case-studies|category|go)(\/|$)/i;

// Job boards / aggregators — never the company's own application page, and their
// copies of postings go stale fast (the classic "no longer accepting applications").
const AGGREGATOR_HOST = /(^|\.)(linkedin\.com|levels\.fyi|vault\.com|themuse\.com|builtin\w*\.com|peerlist\.io|glassdoor\.com|indeed\.com|ziprecruiter\.com|wellfound\.com|simplyhired\.com|monster\.com|dice\.com|internset\.com|web3\.career|tiktok\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|reddit\.com|threads\.net)$/i;

// Path segments that appear on careers *landing* pages. A URL whose path is made up
// entirely of these words (with no job ID) is a program/category page, not a posting.
const GENERIC_SEGMENT = /^(?:go|c|en|us|en-us|en_us|global|americas|search|site|company|career-areas|careers?|careers-at-[\w-]+|jobs?|jobs-at-[\w-]+|intern(?:ship)?s?|interns-jobs|internship-program|internship-opportunities|internships?-and-[\w-]+|early-careers?(?:-jobs)?|early-talent|early-in-career|students?|student-programs|students?-and-[\w-]+|new-grads?|new-graduates?|graduates?|campus|university(?:-[\w-]+)?|entry-level(?:-[\w-]+)?(?:\.aspx)?|job-openings|open-positions|open-opportunities|opportunities|openings|positions|vacancies|working-at-[\w-]+|join(?:-us)?|teams?|technology|engineering)$/i;

export function looksLikeJobUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (AGGREGATOR_HOST.test(u.hostname)) return false;
    if (NON_JOB_PATH.test(u.pathname)) return false;

    // Job ID in the query string (embedded Greenhouse/Lever boards on company
    // sites, e.g. stripe.com/jobs/search?gh_jid=8009143) → specific posting.
    if (/[?&](gh_jid|lever-id|jobid|job_id|jid|req(uisition)?id|posting)=[\w-]{4,}/i.test(u.search)) return true;

    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return false;                 // bare domain / careers subdomain root
    if (segments.some(s => /\d{4,}/.test(s))) return true;   // job-ID-shaped segment → specific posting
    return !segments.every(s => GENERIC_SEGMENT.test(s));    // all-generic path → landing page
  } catch {
    return false;
  }
}

// Phrases that closed-job pages render while still returning HTTP 200
// (Stripe, Apple, ByteDance, SmartRecruiters web pages, custom portals).
// Matched against raw HTML — prune uses this to kill 200-but-dead links
// without any browser or web search.
const DEAD_PAGE_PHRASE = new RegExp([
  'no longer accepting applications',
  'no longer (?:available|active|open|accepting)',
  'position (?:has been |is )?(?:filled|closed)',
  'job (?:posting |opening )?(?:has |is )?(?:been )?(?:closed|filled|expired|removed)',
  // NOTE: bare `has`/`was` here used to match ordinary live-page prose
  // ("this role was first posted", "this role has a competitive salary"),
  // which silently pruned live postings. Every branch must name an
  // explicit dead outcome.
  'this (?:job|role|position|posting|listing) (?:is no longer|has (?:been )?(?:filled|closed|removed|cancell?ed|expired)|was (?:filled|closed|removed|cancell?ed))',
  'posting (?:has expired|is no longer)',
  'job you (?:are looking for|requested) (?:is no longer|could not be found|was not found)',
  'job not found',
  'position not found',
  'requisition .{0,30}not found',
  'sorry[^<.]{0,60}(?:job|position|posting|page)[^<.]{0,60}(?:closed|filled|expired|exist|found|available)',
].join('|'), 'i');

// True if an HTML body contains an explicit closed/removed-job phrase.
// Conservative by design: absence of a phrase does NOT prove the job is live.
export function looksDeadJobPage(html) {
  return DEAD_PAGE_PHRASE.test(html || '');
}
