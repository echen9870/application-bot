#!/usr/bin/env node
/**
 * test-all.mjs — Test suite for career-ops
 *
 * Usage:
 *   node test/test-all.mjs
 *   node test/test-all.mjs --quick   (same — all tests are fast)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMinYOE,
  extractMinYOEFromDesc,
  buildTitleFilter,
  isUS,
  buildCheckboxRequest,
} from '../src/jobs.mjs';

import { looksLikeJobUrl } from '../src/filters.mjs';

import {
  classify,
  extractCompany,
  normalize,
  shouldUpdate,
} from '../src/gmail-sync.mjs';

import { categorizeRows } from '../src/apply.mjs';

import { trainLogistic, predictLogistic, loadModel } from '../src/ml/model.mjs';

import { detectApi, parseLink, parseJobs, extractGHSlug, ATS, cleanDescription } from '../src/ats.mjs';

import { isPermanentError } from '../src/fetch.mjs';

// ── YOE title filter ─────────────────────────────────────────────────

test('extractMinYOE: new grad / entry-level keywords → 0', () => {
  assert.equal(extractMinYOE('New Grad Software Engineer'), 0);
  assert.equal(extractMinYOE('Entry-Level Backend Engineer'), 0);
  assert.equal(extractMinYOE('Software Engineer (Early Career)'), 0);
  assert.equal(extractMinYOE('Junior Developer'), 0);
  assert.equal(extractMinYOE('University Grad SWE'), 0);
  assert.equal(extractMinYOE('Software Engineer 2025'), 0);
});

test('extractMinYOE: explicit YOE ranges in title', () => {
  assert.equal(extractMinYOE('Software Engineer (0-2 YOE)'), 0);
  assert.equal(extractMinYOE('Backend Engineer (2-4 YOE)'), 2);
  assert.equal(extractMinYOE('Senior Engineer (4-6 YOE)'), 4);
  assert.equal(extractMinYOE('Staff Engineer 5+ YOE'), 5);
  assert.equal(extractMinYOE('Engineer 3+ yrs'), 3);
});

test('extractMinYOE: no YOE signal in title → null', () => {
  assert.equal(extractMinYOE('Software Engineer'), null);
  assert.equal(extractMinYOE('Senior Backend Engineer'), null);
  assert.equal(extractMinYOE('Product Manager'), null);
  assert.equal(extractMinYOE(''), null);
});

// ── YOE description filter ───────────────────────────────────────────

test('extractMinYOEFromDesc: common "X+ years of experience" patterns', () => {
  assert.equal(extractMinYOEFromDesc('5+ years of experience required'), 5);
  assert.equal(extractMinYOEFromDesc('2+ years of professional experience'), 2);
  assert.equal(extractMinYOEFromDesc('requires 4+ years of work experience'), 4);
});

test('extractMinYOEFromDesc: range patterns', () => {
  assert.equal(extractMinYOEFromDesc('3-5 years of experience in backend'), 3);
  assert.equal(extractMinYOEFromDesc('4 to 6 years of experience'), 4);
  assert.equal(extractMinYOEFromDesc('7-10 years of professional experience'), 7);
});

test('extractMinYOEFromDesc: minimum / at least patterns', () => {
  assert.equal(extractMinYOEFromDesc('minimum 4 years of work experience'), 4);
  assert.equal(extractMinYOEFromDesc('at least 2 years of experience'), 2);
  assert.equal(extractMinYOEFromDesc('minimum of 3 years of experience'), 3);
});

test('extractMinYOEFromDesc: plain "X years of experience"', () => {
  assert.equal(extractMinYOEFromDesc('you have 5 years of experience in distributed systems'), 5);
});

test('extractMinYOEFromDesc: returns minimum when multiple mentions', () => {
  // Job says "2+ years Python, 6+ years Java" — we take the min (2)
  const desc = '2+ years of experience with python. 6+ years of experience with java.';
  assert.equal(extractMinYOEFromDesc(desc), 2);
});

test('extractMinYOEFromDesc: ignores "years ago" / unrelated year mentions', () => {
  assert.equal(extractMinYOEFromDesc('founded 10 years ago in 2015'), null);
  assert.equal(extractMinYOEFromDesc('5 years serving enterprise customers'), null);
});

test('extractMinYOEFromDesc: null / empty input', () => {
  assert.equal(extractMinYOEFromDesc(null), null);
  assert.equal(extractMinYOEFromDesc(''), null);
  assert.equal(extractMinYOEFromDesc(undefined), null);
});

// ── Title filter ─────────────────────────────────────────────────────

test('buildTitleFilter: positive match required when list non-empty', () => {
  const f = buildTitleFilter({ positive: ['engineer', 'developer'], negative: [] });
  assert.equal(f('Software Engineer'), true);
  assert.equal(f('Frontend Developer'), true);
  assert.equal(f('Product Manager'), false);
  assert.equal(f('Data Scientist'), false);
});

test('buildTitleFilter: negative match always excludes', () => {
  const f = buildTitleFilter({ positive: ['engineer'], negative: ['principal', 'staff', 'vp'] });
  assert.equal(f('Senior Software Engineer'), true);
  assert.equal(f('Principal Engineer'), false);
  assert.equal(f('Staff Software Engineer'), false);
  assert.equal(f('VP of Engineering'), false);
});

test('buildTitleFilter: empty positive list passes everything', () => {
  const f = buildTitleFilter({ positive: [], negative: ['intern'] });
  assert.equal(f('Product Manager'), true);
  assert.equal(f('Software Engineer'), true);
  assert.equal(f('Engineering Intern'), false);
});

test('buildTitleFilter: no config passes everything', () => {
  const f = buildTitleFilter(undefined);
  assert.equal(f('Anything'), true);
  assert.equal(f(''), true);
});

// ── Location (US) filter ─────────────────────────────────────────────

test('isUS: clear US signals', () => {
  assert.equal(isUS('New York, NY'), true);
  assert.equal(isUS('San Francisco, CA'), true);
  assert.equal(isUS('Seattle, WA'), true);
  assert.equal(isUS('United States'), true);
  assert.equal(isUS('Remote, US'), true);
  assert.equal(isUS('Austin, Texas'), true);
});

test('isUS: remote without country defaults to US', () => {
  assert.equal(isUS('Remote'), true);
  assert.equal(isUS('Fully Remote'), true);
});

test('isUS: empty / null location is assumed US', () => {
  assert.equal(isUS(''), true);
  assert.equal(isUS(null), true);
  assert.equal(isUS(undefined), true);
});

test('isUS: non-US countries excluded', () => {
  assert.equal(isUS('Toronto, Canada'), false);
  assert.equal(isUS('London, UK'), false);
  assert.equal(isUS('Berlin, Germany'), false);
  assert.equal(isUS('Amsterdam, Netherlands'), false);
  assert.equal(isUS('Singapore'), false);
  assert.equal(isUS('Tel Aviv, Israel'), false);
});

test('isUS: regional tags excluded', () => {
  assert.equal(isUS('EMEA'), false);
  assert.equal(isUS('APAC Region'), false);
});

test('isUS: bare non-US ISO country codes excluded', () => {
  assert.equal(isUS('HU'), false);
  assert.equal(isUS('RO'), false);
  assert.equal(isUS('GB'), false);
  assert.equal(isUS('hu'), false);
});

test('isUS: Remote with non-US country keywords excluded', () => {
  assert.equal(isUS('Remote Hungary, Romania, Greece & Spain'), false);
  assert.equal(isUS('Remote Canada'), false);
});

// ── Gmail classification ─────────────────────────────────────────────

test('classify: rejection signals', () => {
  assert.equal(classify('Application update', 'We decided to move forward with other candidates'), 'Rejected');
  assert.equal(classify('We regret to inform you', ''), 'Rejected');
  assert.equal(classify('Update on your application', 'unfortunately not a match for this role'), 'Rejected');
  assert.equal(classify('Your application', 'We are not moving forward with your application'), 'Rejected');
  assert.equal(classify('Position update', 'The position has been filled'), 'Rejected');
});

test('classify: interview signals', () => {
  assert.equal(classify("We'd like to schedule a call", ''), 'Interview');
  assert.equal(classify('Next steps', 'Please book a time on our Calendly'), 'Interview');
  assert.equal(classify('Technical interview invitation', ''), 'Interview');
  assert.equal(classify('HackerRank assessment', 'complete your coding assessment'), 'Interview');
  assert.equal(classify('Moving you forward', 'excited to invite you to the next round'), 'Interview');
});

test('classify: offer signals', () => {
  assert.equal(classify("We'd like to extend an offer", ''), 'Offer');
  assert.equal(classify('Offer letter enclosed', 'pleased to offer you the position'), 'Offer');
});

test('classify: offer takes priority over interview signals', () => {
  assert.equal(classify('Offer of employment', 'please schedule a call to discuss'), 'Offer');
});

test('classify: acknowledgment / unknown → null', () => {
  assert.equal(classify('Thank you for applying', 'We received your application'), null);
  assert.equal(classify('Application received', 'Our team will review your profile'), null);
  assert.equal(classify('Weekly digest', 'New jobs matching your criteria'), null);
});

// ── Company extraction ───────────────────────────────────────────────

test('extractCompany: "applied to Company" pattern', () => {
  const c = extractCompany('Your application to Stripe for Backend Engineer', '', 'jobs@lever.co');
  assert.ok(c?.toLowerCase().includes('stripe'), `Expected Stripe, got: ${c}`);
});

test('extractCompany: "at Company" at end of subject', () => {
  const c = extractCompany('[Next Steps] Your Interview at Palantir', '', 'recruiting@greenhouse.io');
  assert.ok(c?.toLowerCase().includes('palantir'), `Expected Palantir, got: ${c}`);
});

test('extractCompany: sender domain fallback', () => {
  const c = extractCompany('Your application update', '', 'careers@arcesium.com');
  assert.ok(c?.toLowerCase().includes('arcesium'), `Expected arcesium, got: ${c}`);
});

test('extractCompany: generic sender → null', () => {
  const c = extractCompany('Application update', '', 'no-reply@greenhouse.io');
  assert.equal(c, null);
});

// ── Status rank (no downgrade) ───────────────────────────────────────

test('shouldUpdate: upgrade always allowed', () => {
  assert.equal(shouldUpdate('Applied', 'Interview'),  true);
  assert.equal(shouldUpdate('Applied', 'Offer'),      true);
  assert.equal(shouldUpdate('Interview', 'Offer'),    true);
});

test('shouldUpdate: downgrade blocked', () => {
  assert.equal(shouldUpdate('Offer', 'Interview'),    false);
  assert.equal(shouldUpdate('Offer', 'Rejected'),     false);
});

test('shouldUpdate: rejected only updates from Applied', () => {
  assert.equal(shouldUpdate('Applied',   'Rejected'), true);
  assert.equal(shouldUpdate('Interview', 'Rejected'), false);  // don't downgrade interview to rejected
  assert.equal(shouldUpdate('Offer',     'Rejected'), false);
});

test('shouldUpdate: same rank is a no-op', () => {
  assert.equal(shouldUpdate('Interview', 'Interview'), false);
});

// ── normalize ────────────────────────────────────────────────────────

test('normalize: strips legal suffixes and punctuation', () => {
  assert.equal(normalize('Stripe, Inc.'), 'stripe');
  assert.equal(normalize('Anthropic LLC'), 'anthropic');
  assert.equal(normalize('Meta Technologies'), 'meta');
  assert.equal(normalize('OpenAI Labs'), 'openai');
});

test('normalize: handles empty / null', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

// ── apply.mjs categorizeRows ─────────────────────────────────────────

test('categorizeRows: ✓ rows go to toApply, blank rows go to toIgnore', () => {
  const rows = [
    ['✓',  '2026-05-01', '2026-04-30', 'Google',    'SWE',     'Remote',      'https://g.co/1', '', ''],
    ['',   '2026-05-01', '2026-04-30', 'Meta',      'SWE',     'Menlo Park',  'https://m.co/2', '', ''],
    ['✓',  '2026-05-01', '2026-04-29', 'Stripe',    'Backend', 'San Francisco','https://s.co/3', '', ''],
    ['',   '2026-05-01', '2026-04-29', 'Palantir',  'SWE',     'New York',    'https://p.co/4', '', ''],
  ];
  const { toApply, toIgnore } = categorizeRows(rows);
  assert.equal(toApply.length,  2);
  assert.equal(toIgnore.length, 2);
  assert.equal(toApply[0].company,  'Google');
  assert.equal(toApply[1].company,  'Stripe');
  assert.equal(toIgnore[0].company, 'Meta');
  assert.equal(toIgnore[1].company, 'Palantir');
});

test('categorizeRows: all checked → all in toApply', () => {
  const rows = [
    ['✓', '2026-05-01', '', 'Anthropic', 'ML Eng', 'SF', 'https://a.co/1', '', ''],
    ['✓', '2026-05-01', '', 'OpenAI',    'SWE',    'SF', 'https://o.co/2', '', ''],
  ];
  const { toApply, toIgnore } = categorizeRows(rows);
  assert.equal(toApply.length,  2);
  assert.equal(toIgnore.length, 0);
});

test('categorizeRows: empty / blank rows skipped', () => {
  const rows = [
    ['', '', '', '', '', '', '', '', ''],       // fully empty
    ['✓', '2026-05-01', '', 'Roblox', 'SWE', 'Remote', 'https://r.co/1', '', ''],
  ];
  const { toApply, toIgnore } = categorizeRows(rows);
  assert.equal(toApply.length,  1);
  assert.equal(toIgnore.length, 0);
});

test('categorizeRows: no rows → both empty', () => {
  const { toApply, toIgnore } = categorizeRows([]);
  assert.equal(toApply.length,  0);
  assert.equal(toIgnore.length, 0);
});

test('categorizeRows: boolean TRUE (Google Sheets checkbox) goes to toApply', () => {
  const rows = [
    ['TRUE',  '2026-05-01', '', 'Stripe', 'SWE', 'Remote', 'https://s.co/1', '', ''],
    ['FALSE', '2026-05-01', '', 'OpenAI', 'SWE', 'Remote', 'https://o.co/1', '', ''],
    ['true',  '2026-05-01', '', 'Glean',  'SWE', 'Remote', 'https://g.co/1', '', ''],
  ];
  const { toApply, toIgnore } = categorizeRows(rows);
  assert.equal(toApply.length,  2);
  assert.equal(toIgnore.length, 1);
  assert.equal(toApply[0].company,  'Stripe');
  assert.equal(toIgnore[0].company, 'OpenAI');
});

test('categorizeRows: native boolean / number cell values do not crash', () => {
  // Sheets API can return real booleans from formula cells (e.g. =IF(...)).
  // categorizeRows must coerce safely instead of throwing on .trim().
  const rows = [
    [true,       '2026-05-01', '', 'Anthropic', 'SWE', 'Remote', 'https://a.co/1', '', ''],
    [false,      '2026-05-01', '', 'OpenAI',    'SWE', 'Remote', 'https://o.co/2', '', ''],
    [null,       '2026-05-01', '', 'Stripe',    'SWE', 'Remote', 'https://s.co/3', '', ''],
    [undefined,  '2026-05-01', '', 'Glean',     'SWE', 'Remote', 'https://g.co/4', '', ''],
    [1,          '2026-05-01', '', 'Foo',       'SWE', 'Remote', 'https://f.co/5', '', ''],
  ];
  // Should not throw
  const { toApply, toIgnore } = categorizeRows(rows);
  // true (→ "true" → uppercased "TRUE") → toApply. All others are blank/falsy → toIgnore.
  assert.equal(toApply.length,  1);
  assert.equal(toApply[0].company, 'Anthropic');
  assert.equal(toIgnore.length, 4);
});

// ── fetch.mjs isPermanentError ───────────────────────────────────────

test('isPermanentError: 4xx (except 429) is permanent', () => {
  assert.equal(isPermanentError(new Error('HTTP 400')), true);
  assert.equal(isPermanentError(new Error('HTTP 401')), true);
  assert.equal(isPermanentError(new Error('HTTP 403')), true);
  assert.equal(isPermanentError(new Error('HTTP 404')), true);
});

test('isPermanentError: 429 (rate limit) is retryable', () => {
  assert.equal(isPermanentError(new Error('HTTP 429')), false);
});

test('isPermanentError: 5xx and network errors are retryable', () => {
  assert.equal(isPermanentError(new Error('HTTP 500')), false);
  assert.equal(isPermanentError(new Error('HTTP 502')), false);
  assert.equal(isPermanentError(new Error('HTTP 503')), false);
  assert.equal(isPermanentError(new Error('fetch failed')),         false);
  assert.equal(isPermanentError(new Error('The operation was aborted')), false);
  assert.equal(isPermanentError(null),                              false);
});

// ── Checkbox request structure ────────────────────────────────────────

test('buildCheckboxRequest: correct BOOLEAN validation structure', () => {
  const req = buildCheckboxRequest(123456789);
  const r   = req.setDataValidation;
  assert.ok(r, 'setDataValidation key must exist');
  assert.equal(r.rule.condition.type, 'BOOLEAN');
  assert.equal(r.rule.showCustomUi, true);
  assert.equal(r.range.sheetId, 123456789);
  assert.equal(r.range.startRowIndex, 1,  'must skip header row');
  assert.equal(r.range.startColumnIndex, 0, 'must target column A');
  assert.equal(r.range.endColumnIndex,   1, 'must only cover column A');
  assert.ok(r.range.endRowIndex > 100, 'endRowIndex must cover many rows');
});

test('buildCheckboxRequest: different sheetIds produce distinct ranges', () => {
  const r1 = buildCheckboxRequest(111).setDataValidation.range;
  const r2 = buildCheckboxRequest(222).setDataValidation.range;
  assert.equal(r1.sheetId, 111);
  assert.equal(r2.sheetId, 222);
});

// ── ATS detection ────────────────────────────────────────────────────

test('detectApi: explicit api field takes precedence', () => {
  assert.equal(detectApi({ api: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs' }).type, 'greenhouse');
  assert.equal(detectApi({ api: 'https://api.ashbyhq.com/posting-api/job-board/anthropic' }).type, 'ashby');
  assert.equal(detectApi({ api: 'https://api.lever.co/v0/postings/openai' }).type, 'lever');
  assert.equal(detectApi({ api: 'https://api.smartrecruiters.com/v1/companies/Google/postings' }).type, 'smartrecruiters');
});

test('detectApi: falls back to careers_url slug extraction', () => {
  const ashby = detectApi({ careers_url: 'https://jobs.ashbyhq.com/anthropic' });
  assert.equal(ashby.type, 'ashby');
  assert.ok(ashby.url.includes('anthropic'));

  const lever = detectApi({ careers_url: 'https://jobs.lever.co/openai/some-job' });
  assert.equal(lever.type, 'lever');
  assert.ok(lever.url.includes('openai'));

  const gh = detectApi({ careers_url: 'https://job-boards.greenhouse.io/stripe' });
  assert.equal(gh.type, 'greenhouse');
  assert.ok(gh.url.includes('stripe'));
});

test('detectApi: no api or known careers_url → null', () => {
  assert.equal(detectApi({ name: 'Foo', careers_url: 'https://foo.com/careers' }), null);
  assert.equal(detectApi({}), null);
});

test('extractGHSlug: pulls slug from board URL', () => {
  assert.equal(extractGHSlug('https://boards-api.greenhouse.io/v1/boards/stripe/jobs'), 'stripe');
  assert.equal(extractGHSlug('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/123'), 'anthropic');
  assert.equal(extractGHSlug('not-a-real-url'), '');
});

// ── parseLink (used by prune) ────────────────────────────────────────

test('parseLink: Greenhouse job URL → { greenhouse, slug, id }', () => {
  const r = parseLink('https://job-boards.greenhouse.io/stripe/jobs/4567890');
  assert.equal(r.type, 'greenhouse');
  assert.equal(r.slug, 'stripe');
  assert.equal(r.id,   '4567890');
});

test('parseLink: Ashby job URL → { ashby, slug, id }', () => {
  const uuid = 'abcd1234-ef56-7890-abcd-ef1234567890';
  const r = parseLink(`https://jobs.ashbyhq.com/anthropic/${uuid}`);
  assert.equal(r.type, 'ashby');
  assert.equal(r.slug, 'anthropic');
  assert.equal(r.id,   uuid);
});

test('parseLink: Lever job URL → { lever, slug, id }', () => {
  const uuid = 'fedcba98-7654-3210-fedc-ba9876543210';
  const r = parseLink(`https://jobs.lever.co/openai/${uuid}`);
  assert.equal(r.type, 'lever');
  assert.equal(r.slug, 'openai');
  assert.equal(r.id,   uuid);
});

test('parseLink: unknown host → generic', () => {
  assert.equal(parseLink('https://stripe.com/careers/123').type, 'generic');
});

test('parseLink: null / invalid → null', () => {
  assert.equal(parseLink(''), null);
  assert.equal(parseLink(null), null);
  assert.equal(parseLink('not a url'), null);
});

// ── parseJobs (ATS JSON shape parsers) ───────────────────────────────

test('parseJobs greenhouse: maps fields correctly + carries _slug/_id', () => {
  const json = {
    jobs: [
      { id: 12345, title: 'Backend Engineer', absolute_url: 'https://x.com/1', location: { name: 'SF' }, updated_at: '2026-05-10T00:00:00Z' },
    ],
  };
  const out = parseJobs('greenhouse', json, 'Stripe', 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs');
  assert.equal(out.length, 1);
  assert.equal(out[0].company, 'Stripe');
  assert.equal(out[0].role,    'Backend Engineer');
  assert.equal(out[0].link,    'https://x.com/1');
  assert.equal(out[0].location,'SF');
  assert.equal(out[0].posted,  '2026-05-10');
  assert.equal(out[0]._slug,   'stripe');
  assert.equal(out[0]._id,     '12345');
});

test('parseJobs ashby: maps fields and lowercases descriptionPlain', () => {
  const json = {
    jobs: [
      { title: 'SWE', jobUrl: 'https://ash/1', location: 'Remote', publishedAt: '2026-05-09', descriptionPlain: 'WE NEED PYTHON' },
    ],
  };
  const out = parseJobs('ashby', json, 'Anthropic');
  assert.equal(out[0].description, 'we need python');
  assert.equal(out[0].posted,      '2026-05-09');
});

test('parseJobs lever: handles array input', () => {
  const json = [
    { text: 'Founding Engineer', hostedUrl: 'https://l/1', categories: { location: 'NYC' }, createdAt: 1714521600000 },
  ];
  const out = parseJobs('lever', json, 'OpenAI');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'Founding Engineer');
  assert.equal(out[0].location, 'NYC');
});

test('parseJobs lever: extracts inline description (lowercased, from board listing)', () => {
  const json = [
    { text: 'SWE', hostedUrl: 'https://l/1', categories: { location: 'NYC' },
      descriptionPlain: 'We need PYTHON and 5 Years', description: '<p>ignored html</p>' },
  ];
  const out = parseJobs('lever', json, 'OpenAI');
  assert.equal(out[0].description, 'we need python and 5 years');
});

test('parseJobs smartrecruiters: city/region/country join + countryCode fallback', () => {
  const json = {
    content: [
      { name: 'SWE', id: 'a1', company: { identifier: 'Google' }, location: { city: 'NYC', region: 'NY', country: 'US' } },
      { name: 'SWE',         id: 'a2', company: { identifier: 'Google' }, location: { countryCode: 'HU' } },
    ],
  };
  const out = parseJobs('smartrecruiters', json, 'Google');
  assert.equal(out[0].location, 'NYC, NY, US');
  assert.equal(out[1].location, 'HU');
  assert.ok(out[0].link.includes('jobs.smartrecruiters.com/Google/a1'));
  // _slug/_id are carried for the per-job description fetch
  assert.equal(out[0]._slug, 'Google');
  assert.equal(out[0]._id, 'a1');
});

test('detectApi: myworkdayjobs.com api → workday', () => {
  assert.equal(detectApi({ api: 'https://capitalone.wd12.myworkdayjobs.com/Capital_One' }).type, 'workday');
  assert.equal(detectApi({ careers_url: 'https://capitalone.wd12.myworkdayjobs.com/Capital_One' }).type, 'workday');
});

test('parseLink: workday job URL → { workday, info, externalPath }', () => {
  const r = parseLink('https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/Richmond-VA/Senior-Platform-Engineer_R237242-1');
  assert.equal(r.type, 'workday');
  assert.equal(r.info.tenant, 'capitalone');
  assert.equal(r.info.site,   'Capital_One');
  assert.equal(r.externalPath, '/job/Richmond-VA/Senior-Platform-Engineer_R237242-1');
});

test('parseJobs workday: builds correct link from externalPath and converts postedOn', () => {
  const json = {
    _info: { host: 'capitalone.wd12.myworkdayjobs.com', tenant: 'capitalone', site: 'Capital_One' },
    jobPostings: [
      { title: 'SWE', externalPath: '/job/SF/Software-Engineer_R1', locationsText: 'San Francisco, CA', postedOn: 'Posted Today' },
      { title: 'SWE II', externalPath: '/job/NY/SWE-II_R2', locationsText: 'New York, NY', postedOn: 'Posted 5 Days Ago' },
    ],
  };
  const out = ATS.workday.parse(json, 'Capital One');
  assert.equal(out[0].link, 'https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/SF/Software-Engineer_R1');
  assert.equal(out[0].location, 'San Francisco, CA');
  assert.equal(out[0].posted, new Date().toISOString().slice(0, 10));
  assert.equal(out[1].posted, new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10));
});

test('detectApi: career-schwab.icims.com api → schwabicims', () => {
  assert.equal(detectApi({ api: 'https://career-schwab.icims.com/jobs/search?ss=1' }).type, 'schwabicims');
});

test('parseLink: schwabicims job URL → { schwabicims, id }', () => {
  const r = parseLink('https://career-schwab.icims.com/jobs/121922/senior-java-developer/job');
  assert.equal(r.type, 'schwabicims');
  assert.equal(r.id, '121922');
});

test('parseJobs schwabicims: decodes slug to title, parses US location', () => {
  const json = { jobs: [{ id: '121922', rawSlug: 'senior-java-developer', rawLoc: 'US-TX-Southlake | US-CO-Denver', link: 'https://career-schwab.icims.com/jobs/121922/senior-java-developer/job' }] };
  const out = ATS.schwabicims.parse(json, 'Charles Schwab');
  assert.equal(out[0].role, 'Senior Java Developer');
  assert.equal(out[0].location, 'Southlake, TX');
  assert.equal(out[0].link, 'https://career-schwab.icims.com/jobs/121922/senior-java-developer/job');
});

test('detectApi: join.atlassian.com api → atlassian', () => {
  assert.equal(detectApi({ api: 'https://join.atlassian.com/api/jobs?country=United+States' }).type, 'atlassian');
});

test('parseLink: Atlassian job URL → { atlassian, id }', () => {
  const r = parseLink('https://join.atlassian.com/atlassian-talent-community/jobs/20362?lang=en-us');
  assert.equal(r.type, 'atlassian');
  assert.equal(r.id, '20362');
});

test('parseJobs atlassian: maps fields correctly', () => {
  const json = { jobs: [{ req_id: '20362', title: 'Software Engineer', short_location: 'Austin, Texas', posted_date: '2026-05-13T00:00:00+0000', description: '<p>backend work</p>' }] };
  const out = ATS.atlassian.parse(json, 'Atlassian');
  assert.equal(out[0].role, 'Software Engineer');
  assert.equal(out[0].link, 'https://join.atlassian.com/atlassian-talent-community/jobs/20362?lang=en-us');
  assert.equal(out[0].location, 'Austin, Texas');
  assert.equal(out[0].posted, '2026-05-13');
  assert.ok(out[0].description.includes('backend work'));
});

test('detectApi: plaid.com/careers api → plaidcareers', () => {
  assert.equal(detectApi({ api: 'https://plaid.com/careers/' }).type, 'plaidcareers');
});

test('parseLink: plaid careers URL → { plaidcareers, id }', () => {
  const r = parseLink('https://plaid.com/careers/openings/engineering/california/software-engineer-backend/');
  assert.equal(r.type, 'plaidcareers');
  assert.equal(r.id,   'software-engineer-backend');
});

test('parseJobs plaidcareers: US loc → United States, non-US loc stays raw', () => {
  const json = { jobs: [
    { path: '/careers/openings/eng/california/swe/', locSeg: 'california', slug: 'swe' },
    { path: '/careers/openings/eng/gbr-lon-office/swe-europe/', locSeg: 'gbr-lon-office', slug: 'swe-europe' },
  ]};
  const out = ATS.plaidcareers.parse(json, 'Plaid');
  assert.equal(out[0].location, 'United States');
  assert.equal(out[0].role, 'Swe');
  assert.equal(out[1].location, 'gbr-lon-office');  // non-US, stays raw
});

test('parseLink: apple careers URL → { applecareers, id }', () => {
  const r = parseLink('https://jobs.apple.com/en-us/details/200613725-0836/ios-engineer-apple-tv');
  assert.equal(r.type, 'applecareers');
  assert.equal(r.id,   '200613725-0836');
});

test('detectApi: jobs.apple.com api → applecareers', () => {
  assert.equal(detectApi({ api: 'https://jobs.apple.com/en-us/search?location=united-states-USA' }).type, 'applecareers');
});

test('parseJobs applecareers: builds link, appends USA to city, parses date', () => {
  const json = { jobs: [{ id: '200613725-0836', title: 'iOS Engineer', city: 'Cupertino', posted: 'May 12, 2026' }] };
  const out = ATS.applecareers.parse(json, 'Apple');
  assert.equal(out[0].role, 'iOS Engineer');
  assert.equal(out[0].link, 'https://jobs.apple.com/en-us/details/200613725-0836');
  assert.equal(out[0].location, 'Cupertino, USA');
  assert.equal(out[0].posted, '2026-05-12');
});

test('parseLink: google careers URL → { googlecareers, id }', () => {
  const r = parseLink('https://www.google.com/about/careers/applications/jobs/results/122948486462087878-software-engineer-crossplatform-material');
  assert.equal(r.type, 'googlecareers');
  assert.equal(r.id,   '122948486462087878');
});

test('detectApi: google.com/about/careers api → googlecareers', () => {
  assert.equal(detectApi({ api: 'https://www.google.com/about/careers/applications/jobs/results?q=software+engineer' }).type, 'googlecareers');
});

test('parseJobs googlecareers: builds link from id, hardcodes US location', () => {
  const json = { jobs: [{ id: '12345', title: 'Software Engineer, GenAI' }] };
  const out = ATS.googlecareers.parse(json, 'Google');
  assert.equal(out[0].role, 'Software Engineer, GenAI');
  assert.equal(out[0].link, 'https://www.google.com/about/careers/applications/jobs/results/12345');
  assert.equal(out[0].location, 'United States');
  assert.equal(out[0].posted, '');
});

test('detectApi: amazon.jobs api → amazon', () => {
  assert.equal(detectApi({ api: 'https://www.amazon.jobs/en/search.json?base_query=engineer' }).type, 'amazon');
});

test('parseLink: amazon job URL → { amazon, id }', () => {
  const r = parseLink('https://www.amazon.jobs/en/jobs/3202388/software-engineer-i-commerce-engineering');
  assert.equal(r.type, 'amazon');
  assert.equal(r.id,   '3202388');
});

test('parseJobs amazon: maps fields, strips HTML, falls back to country_code', () => {
  const json = {
    jobs: [
      { id: 1, title: 'SDE I', job_path: '/en/jobs/1/sde-i', city: 'Seattle', state: 'WA', country_code: 'USA',
        posted_date: 'May 11, 2026', description: '<p>Build stuff</p>', basic_qualifications: '<br/>1+ years of experience' },
      { id: 2, title: 'SDE II', job_path: '/en/jobs/2', city: '', state: '', country_code: 'USA', posted_date: 'May 10, 2026' },
    ],
  };
  const out = parseJobs('amazon', json, 'Amazon');
  assert.equal(out[0].role,        'SDE I');
  assert.equal(out[0].link,        'https://www.amazon.jobs/en/jobs/1/sde-i');
  assert.equal(out[0].location,    'Seattle, WA');
  assert.equal(out[0].posted,      '2026-05-11');
  assert.ok(out[0].description.includes('build stuff'));
  assert.ok(!out[0].description.includes('<'));
  assert.equal(out[1].location,    'USA');   // country_code fallback
});

test('parseJobs: missing/empty fields default safely', () => {
  assert.deepEqual(parseJobs('greenhouse', { jobs: [] }, 'X', 'https://boards-api.greenhouse.io/v1/boards/x/jobs'), []);
  assert.deepEqual(parseJobs('ashby', {}, 'X'), []);
  assert.deepEqual(parseJobs('lever', null, 'X'), []);
  assert.deepEqual(parseJobs('smartrecruiters', {}, 'X'), []);
});

// ── ATS URL templates ────────────────────────────────────────────────

test('ATS URL templates: well-formed', () => {
  assert.equal(ATS.greenhouse.boardApi('stripe'),    'https://boards-api.greenhouse.io/v1/boards/stripe/jobs');
  assert.equal(ATS.greenhouse.jobApi('stripe', 42),  'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/42');
  assert.ok(ATS.ashby.boardApi('anthropic').includes('/posting-api/job-board/anthropic'));
  assert.equal(ATS.lever.boardApi('openai'),         'https://api.lever.co/v0/postings/openai');
  assert.equal(ATS.lever.jobApi('openai', 'abc-123'),'https://api.lever.co/v0/postings/openai/abc-123');
  assert.ok(ATS.smartrecruiters.boardApi('Google').includes('/v1/companies/Google/postings'));
  assert.equal(ATS.smartrecruiters.jobApi('Google', 'a1'), 'https://api.smartrecruiters.com/v1/companies/Google/postings/a1');
});

// ── cleanDescription (HTML → plain lowercased text for storage/scoring) ──

test('cleanDescription: decodes entities, strips tags, collapses whitespace, lowercases', () => {
  // Greenhouse-style double-encoded HTML
  assert.equal(cleanDescription('&lt;p&gt;Build   STUFF&lt;/p&gt;'), 'build stuff');
  // Real tags stripped
  assert.equal(cleanDescription('<h2>Backend</h2> <b>Engineer</b>'), 'backend engineer');
  // Ampersand decoded last (no double-decode)
  assert.equal(cleanDescription('R&amp;D team'), 'r&d team');
});

test('cleanDescription: empty/nullish input → empty string', () => {
  assert.equal(cleanDescription(''), '');
  assert.equal(cleanDescription(null), '');
  assert.equal(cleanDescription(undefined), '');
});

// ── looksLikeJobUrl heuristic (used to filter websearch noise) ───────

test('looksLikeJobUrl: real ATS-shaped URLs accepted', () => {
  assert.equal(looksLikeJobUrl('https://job-boards.greenhouse.io/stripe/jobs/12345'), true);
  assert.equal(looksLikeJobUrl('https://jobs.ashbyhq.com/anthropic/abc-123'),         true);
  assert.equal(looksLikeJobUrl('https://jobs.lever.co/openai/abc-456'),               true);
  assert.equal(looksLikeJobUrl('https://stripe.com/jobs/listing/some-role/789'),      true);
});

test('looksLikeJobUrl: blog/news/podcast URLs rejected', () => {
  assert.equal(looksLikeJobUrl('https://stripe.com/blog/scaling-payments'),         false);
  assert.equal(looksLikeJobUrl('https://anthropic.com/news/claude-4-7'),            false);
  assert.equal(looksLikeJobUrl('https://example.com/press/2026-announcement'),      false);
  assert.equal(looksLikeJobUrl('https://example.com/podcast/episode-42'),           false);
  assert.equal(looksLikeJobUrl('https://example.com/insights/state-of-the-art'),    false);
  assert.equal(looksLikeJobUrl('https://example.com/customers/case-study'),         false);
  assert.equal(looksLikeJobUrl('https://example.com/case-studies/foo-corp'),        false);
});

test('looksLikeJobUrl: empty / invalid → false', () => {
  assert.equal(looksLikeJobUrl(''),         false);
  assert.equal(looksLikeJobUrl(null),       false);
  assert.equal(looksLikeJobUrl('not-url'),  false);
});

// ── ml/model.mjs — logistic regression head ──────────────────────────

// Tiny separable set in 4-dim: positives point along +x, negatives along -x.
function syntheticSet(nPos, nNeg) {
  const X = [], y = [];
  for (let i = 0; i < nPos; i++) { X.push([ 1, 0.1 * (i % 3), 0, 0]); y.push(1); }
  for (let i = 0; i < nNeg; i++) { X.push([-1, 0, 0.1 * (i % 3), 0]); y.push(0); }
  return { X, y };
}

test('trainLogistic: learns a separable set', () => {
  const { X, y } = syntheticSet(10, 10);
  const model = trainLogistic(X, y);
  assert.ok(predictLogistic(model, [1, 0, 0, 0]) > 0.5);
  assert.ok(predictLogistic(model, [-1, 0, 0, 0]) < 0.5);
  assert.equal(model.meta.nPos, 10);
  assert.equal(model.meta.nNeg, 10);
});

test('trainLogistic: class weighting handles imbalance', () => {
  const { X, y } = syntheticSet(3, 30);   // rare positives
  const model = trainLogistic(X, y);
  assert.ok(predictLogistic(model, [1, 0, 0, 0]) > 0.5, 'minority class still classified');
  assert.ok(predictLogistic(model, [-1, 0, 0, 0]) < 0.5);
});

test('trainLogistic: rejects single-class or empty input', () => {
  assert.throws(() => trainLogistic([], []));
  assert.throws(() => trainLogistic([[1, 0]], [1]));
});

test('predictLogistic: output bounded (0, 1)', () => {
  const model = { weights: [10, 0], bias: 0, meta: {} };
  const hi = predictLogistic(model, [1, 0]);
  const lo = predictLogistic(model, [-1, 0]);
  assert.ok(hi > 0 && hi < 1 && lo > 0 && lo < 1);
  assert.ok(hi > 0.99 && lo < 0.01);
});

test('loadModel: null or valid shape (never garbage)', () => {
  const m = loadModel();
  assert.ok(m === null || (Array.isArray(m.weights) && typeof m.bias === 'number'));
});

// ── ml/training-data.mjs + model persistence + retrain guard ────────
// These write files, so they run chdir'd into a temp dir (restored via finally)
// to never touch the real data/ directory.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function inTempDir(fn) {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-test-'));
  try { process.chdir(dir); await fn(); }
  finally { process.chdir(orig); rmSync(dir, { recursive: true, force: true }); }
}

test('training-data: save/load round-trip, overwrite by link, invalid entries dropped', async () => {
  const { loadTrainingData, saveTrainingData } = await import('../src/ml/training-data.mjs');
  await inTempDir(() => {
    assert.deepEqual(loadTrainingData(), {});           // absent file → {}
    const written = saveTrainingData([
      { link: 'https://x/1', label: 1, company: 'A', role: 'SWE', text: 't', embedding: [0.1, 0.2] },
      { link: 'https://x/2', label: 0, embedding: [0.3] },
      { link: '',            label: 1, embedding: [1] },  // no link → dropped
      { link: 'https://x/3', label: 2, embedding: [1] },  // bad label → dropped
      { link: 'https://x/4', label: 1 },                  // no embedding → dropped
    ]);
    assert.equal(written, 2);
    let store = loadTrainingData();
    assert.equal(Object.keys(store).length, 2);
    assert.equal(store['https://x/1'].label, 1);
    // Relabel the same link → overwrites, no duplicate
    saveTrainingData([{ link: 'https://x/1', label: 0, embedding: [0.1, 0.2] }]);
    store = loadTrainingData();
    assert.equal(Object.keys(store).length, 2);
    assert.equal(store['https://x/1'].label, 0);
  });
});

test('model: saveModel/loadModel round-trip', async () => {
  const { trainLogistic, saveModel, loadModel: load } = await import('../src/ml/model.mjs');
  await inTempDir(() => {
    const { X, y } = syntheticSet(10, 10);
    const model = trainLogistic(X, y);
    saveModel(model);
    const loaded = load();
    assert.deepEqual(loaded.weights, model.weights);
    assert.equal(loaded.bias, model.bias);
    assert.equal(loaded.meta.nPos, 10);
  });
});

test('retrain: guard skips training when labels are insufficient', async () => {
  const { retrain } = await import('../src/train.mjs');
  const { saveTrainingData } = await import('../src/ml/training-data.mjs');
  await inTempDir(async () => {
    // Empty store → skipped
    let res = await retrain();
    assert.equal(res.trained, false);
    // One class only (below MIN_PER_CLASS for negatives) → still skipped
    saveTrainingData(Array.from({ length: 12 }, (_, i) =>
      ({ link: `https://x/${i}`, label: 1, text: 'SWE at X\n\nreal description here', embedding: [1, 0] })));
    res = await retrain();
    assert.equal(res.trained, false);
    assert.equal(res.nPos, 12);
    // Title-only entries (no "\n\n" description marker) are excluded from training
    saveTrainingData(Array.from({ length: 12 }, (_, i) =>
      ({ link: `https://x/t${i}`, label: 0, text: 'SWE at Y in NYC', embedding: [0, 1] })));
    res = await retrain();
    assert.equal(res.trained, false, 'title-only negatives must not count toward the guard');
    assert.equal(res.nNeg, 0);
  });
});

test('evaluateHoldout: metrics on separable data, null when a class is tiny', async () => {
  const { evaluateHoldout } = await import('../src/ml/model.mjs');
  const { X, y } = syntheticSet(20, 40);
  const ho = evaluateHoldout(X, y);
  assert.ok(ho.precision === 1 && ho.recall === 1, 'separable data → perfect holdout metrics');
  assert.equal(ho.nTestPos, 4);   // floor(20 * 0.2)
  assert.equal(ho.nTestNeg, 8);
  // Deterministic across runs (seeded shuffle)
  assert.deepEqual(evaluateHoldout(X, y), ho);
  // Too few positives to split → null
  const small = syntheticSet(3, 40);
  assert.equal(evaluateHoldout(small.X, small.y), null);
});

test('deleteDescriptions: removes only named links, persists', async () => {
  const { loadDescriptions, saveDescriptions, deleteDescriptions } = await import('../src/ml/descriptions.mjs');
  await inTempDir(() => {
    saveDescriptions([
      { link: 'https://x/keep', company: 'A', role: 'r', description: 'long enough description text' },
      { link: 'https://x/drop', company: 'B', role: 'r', description: 'long enough description text' },
    ]);
    assert.equal(deleteDescriptions(['https://x/drop', 'https://x/never-existed']), 1);
    const cache = loadDescriptions();
    assert.ok('https://x/keep' in cache);
    assert.ok(!('https://x/drop' in cache));
    assert.equal(deleteDescriptions([]), 0);
  });
});

// ── Rubric scoring (src/ml/rubric.mjs) ───────────────────────────────────────
// rubricScore takes plain vectors, so it is fully testable without the embedding
// model. embedRubric (which does download/run the model) is not exercised here.

import { writeFileSync } from 'node:fs';

test('loadRubric: missing file → null, valid file → parsed', async () => {
  const { loadRubric } = await import('../src/ml/rubric.mjs');
  await inTempDir(() => {
    assert.equal(loadRubric('rubric.yml'), null);       // absent → null (no throw)
    writeFileSync('rubric.yml',
      'yoe:\n  min: 0\n  max: 3\npreferred_domains:\n  - name: Dist\n    description: distributed systems\n    weight: 2\npreferred_skills: [Go, Rust]\n');
    const r = loadRubric('rubric.yml');
    assert.equal(r.yoe.max, 3);
    assert.equal(r.preferred_domains[0].name, 'Dist');
    assert.deepEqual(r.preferred_skills, ['Go', 'Rust']);
  });
});

test('rubricScore: picks the highest-weighted matching domain', async () => {
  const { rubricScore } = await import('../src/ml/rubric.mjs');
  const er = {
    domains: [
      { name: 'Dist',    weight: 2, vec: [1, 0, 0, 0] },
      { name: 'Backend', weight: 1, vec: [0, 1, 0, 0] },
    ],
    antis: [],
    skills: [],
    yoe: { max: 3 },
  };
  // Job leans toward Dist → topDomain Dist, score = cos(1)·(2/2) = 1
  let r = rubricScore(er, [0.8, 0.6, 0, 0], 'backend role', 'backend role');
  assert.equal(r.topDomain, 'Dist');
  assert.ok(r.score > 0.7);
  assert.equal(r.antiHit, null);
  assert.equal(r.yoeCapped, false);
});

test('rubricScore: anti penalty triggers only when anti cosine beats every domain', async () => {
  const { rubricScore } = await import('../src/ml/rubric.mjs');
  const er = {
    domains: [{ name: 'Dist', weight: 2, vec: [1, 0, 0, 0] }],
    antis:   [{ name: 'Mobile', vec: [0, 0, 1, 0] }],
    skills: [], yoe: {},
  };
  // Resembles the anti more than the domain → penalized
  const hit = rubricScore(er, [0.3, 0, 0.95, 0], '', '');
  assert.equal(hit.antiHit, 'Mobile');
  // Resembles the domain more than the anti → no penalty
  const clean = rubricScore(er, [0.95, 0, 0.3, 0], '', '');
  assert.equal(clean.antiHit, null);
  // Same base domainScore, so the penalty must have halved the hit case
  assert.ok(hit.score < clean.score);
});

test('rubricScore: YOE gate discounts jobs demanding more than yoe.max', async () => {
  const { rubricScore } = await import('../src/ml/rubric.mjs');
  const er = { domains: [{ name: 'Dist', weight: 1, vec: [1, 0, 0, 0] }], antis: [], skills: [], yoe: { max: 3 } };
  const capped = rubricScore(er, [1, 0, 0, 0], 'Backend Engineer 5+ years', 'Backend Engineer 5+ years');
  assert.equal(capped.yoeCapped, true);
  const ok = rubricScore(er, [1, 0, 0, 0], 'New Grad Backend Engineer', 'New Grad Backend Engineer');
  assert.equal(ok.yoeCapped, false);
  assert.ok(capped.score < ok.score);   // 0.3× multiplier applied
});

test('rubricScore: skill match is word-boundary and literal', async () => {
  const { rubricScore } = await import('../src/ml/rubric.mjs');
  const er = { domains: [], antis: [], skills: ['go', 'c++'], yoe: {} };
  // "Go" and "C++" present as standalone tokens → both hit → full 0.1 bonus
  const hit = rubricScore(er, [0, 0, 0, 0], 'we write Go and C++ daily', '');
  assert.ok(Math.abs(hit.score - 0.1) < 1e-9, `expected 0.1 skill bonus, got ${hit.score}`);
  // "Google"/"golang" must NOT match "go"; no "c++" either → zero bonus
  const miss = rubricScore(er, [0, 0, 0, 0], 'google golang engineer', '');
  assert.equal(miss.score, 0);
});

test('scoreJobs: no rubric.yml present → resume mode, no .rubricInfo', async (t) => {
  const { scoreJobs } = await import('../src/ml/scorer.mjs');
  await inTempDir(async () => {
    // No rubric.yml and no model.json in this temp cwd → pure resume cosine.
    const jobs = [{ company: 'A', role: 'Backend Engineer', location: 'NYC', description:
      'We build distributed backend services and storage systems at massive scale every day.' }];
    let scored;
    try {
      scored = await scoreJobs('Backend engineer with distributed systems experience.', jobs);
    } catch (e) {
      // The embedding model isn't cached and can't be fetched (offline CI) — skip
      // rather than fail; the rubricScore tests above cover the pure logic.
      t.skip(`embedding model unavailable: ${e.message}`);
      return;
    }
    assert.equal(scored.length, 1);
    assert.equal(scored[0].rubricInfo, undefined, 'resume mode must not attach rubricInfo');
    assert.equal(typeof scored[0].cosine, 'number');
    assert.equal(scored[0].score, scored[0].cosine, 'no model → score equals cosine anchor');
  });
});

test('rubricScore: penalty keywords subtract, word-boundary matched', async () => {
  const { rubricScore } = await import('../src/ml/rubric.mjs');
  const er = {
    domains: [{ name: 'Dist', weight: 2, vec: [1, 0, 0, 0] }],
    antis: [], skills: [], languages: [],
    penalties: ['terraform', 'agile'],
    yoe: { max: 3 },
  };
  const vec = [1, 0, 0, 0];
  const clean = rubricScore(er, vec, 'distributed systems role', 'SWE');
  const oneHit = rubricScore(er, vec, 'we use terraform daily', 'SWE');
  const bothHit = rubricScore(er, vec, 'agile terraform shop', 'SWE');
  assert.ok(oneHit.score < clean.score, 'one penalty hit lowers the score');
  assert.ok(bothHit.score < oneHit.score, 'more penalty hits lower it further');
  // word-boundary: "agilent" must not match "agile"
  const noHit = rubricScore(er, vec, 'we buy agilent hardware', 'SWE');
  assert.equal(noHit.score, clean.score);
});
