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
];

export const NON_US_COUNTRY_CODES = new Set([
  'ca','gb','de','fr','nl','se','es','pl','rs','jp','au','in','br','sg','il',
  'ae','mx','ar','dk','ie','fi','no','ch','at','be','pt','cz','ro','hu','tr',
  'kr','cn','tw','hk','nz','za','ee','lv','lt','ua','ru','it','gr','hr','sk',
]);

export function extractMinYOE(title) {
  if (/new\s*grad|early\s*career|intern|entry[\s-]level|junior|university\s*grad|\b202[5-9]\b/i.test(title)) return 0;
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

export function isUS(location) {
  if (!location || !location.trim()) return true;
  const lc = location.toLowerCase().trim();
  if (NON_US_COUNTRY.some(c => lc.includes(c))) return false;
  if (NON_US_COUNTRY_CODES.has(lc)) return false;
  if (lc.includes('united states') || /\bus\b/.test(lc)) return true;
  if (lc.includes('remote')) return true;
  if (/,\s*([a-z]{2})\b/.test(lc)) {
    const matches = [...lc.matchAll(/,\s*([a-z]{2})\b/g)];
    if (matches.some(m => US_STATES.has(m[1]))) return true;
  }
  const US_CITIES = ['new york','san francisco','seattle','boston','chicago',
    'austin','denver','los angeles','atlanta','miami','washington','houston',
    'philadelphia','phoenix','portland','minneapolis','detroit','nashville',
    'raleigh','salt lake','san jose','san diego','pittsburgh','cincinnati'];
  if (US_CITIES.some(c => lc.includes(c))) return true;
  return false;
}

export function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase());
  const neg = (tf?.negative || []).map(k => k.toLowerCase());
  return t => {
    const lc = t.toLowerCase();
    return (pos.length === 0 || pos.some(k => lc.includes(k))) && !neg.some(k => lc.includes(k));
  };
}

// Heuristic check: does this URL look like a job posting (not a blog/news/podcast page)?
// Used to filter websearch results without Claude having to inspect each one in-context.
// Conservative: only rejects obvious non-job URLs, accepts ambiguous cases.
const NON_JOB_PATH = /\/(blog|news|press|article|story|podcast|webinar|insights?|guides?|resources?|stories|customers?|case-studies)(\/|$)/i;
export function looksLikeJobUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !NON_JOB_PATH.test(u.pathname);
  } catch {
    return false;
  }
}
