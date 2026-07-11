/**
 * rubric.mjs — preference-rubric scoring.
 *
 * The resume-cosine anchor in scorer.mjs answers "does this JD resemble my
 * background?". A rubric answers the different question "is this the kind of
 * work I WANT?" — expressed by hand in rubric.yml rather than inferred from the
 * resume. When rubric.yml exists, its score replaces the resume-cosine anchor in
 * the blend with the feedback model (see scorer.mjs); the feedback model blend
 * itself is unchanged.
 *
 * A rubric has three parts:
 *   - preferred_domains — weighted, full-sentence descriptions of desired work,
 *     embedded once and compared to each job by cosine.
 *   - anti_preferences  — full-sentence descriptions of undesired work; a job is
 *     penalized only when it resembles an anti more than any preferred domain.
 *   - preferred_skills / programming_languages — plain keywords matched
 *     literally against the JD text (word-boundary), never embedded; each list
 *     contributes its own small bonus.
 *   - penalty_keywords  — literal keywords that reliably mark ignored jobs;
 *     each hit subtracts from the score.
 * Plus a yoe window: jobs demanding more than yoe.max are heavily discounted.
 *
 * Exports:
 *   loadRubric(path?)                              → parsed rubric | null
 *   embedRubric(rubric)                            → { domains, antis, skills, yoe } (async)
 *   rubricScore(embeddedRubric, jobVec, jobText, jobRole)
 *                                                  → { score, topDomain, antiHit, yoeCapped }
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { embed } from './scorer.mjs';
import { extractMinYOE, extractMinYOEFromDesc } from '../filters.mjs';

const RUBRIC_PATH = 'rubric.yml';
const SKILL_BONUS_SCALE = 0.1;   // max skill bonus (all skills present) added to score
const LANG_BONUS_SCALE  = 0.1;   // max programming-language bonus, separate from skills
const PENALTY_SCALE     = 0.2;   // max penalty-keyword deduction (all penalties present)
const ANTI_PENALTY      = 0.5;   // multiply score when a job resembles an anti most
const YOE_PENALTY       = 0.3;   // multiply score when the job demands too much experience

// ── Load ───────────────────────────────────────────────────────────────────

/**
 * Load and parse rubric.yml. Never throws — a missing or unparseable file
 * yields null (scorer.mjs then falls back to plain resume-cosine scoring).
 * @param {string} [path='rubric.yml']
 * @returns {object|null}
 */
export function loadRubric(path = RUBRIC_PATH) {
  if (!existsSync(path)) return null;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`[rubric] ${path} is empty or not a mapping — ignoring.`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn(`[rubric] failed to parse ${path}: ${e.message} — ignoring.`);
    return null;
  }
}

// ── Embed ────────────────────────────────────────────────────────────────────

/**
 * Embed each domain and anti-preference description once (using the same MiniLM
 * model scorer.mjs uses), returning a compact structure ready for rubricScore().
 * Skills are lowercased for literal matching; yoe is passed through.
 * @param {object} rubric  parsed rubric (from loadRubric)
 * @returns {Promise<{ domains: {name,weight,vec}[], antis: {name,vec}[], skills: string[], yoe: object }>}
 */
export async function embedRubric(rubric) {
  const domainDefs = Array.isArray(rubric.preferred_domains) ? rubric.preferred_domains : [];
  const antiDefs   = Array.isArray(rubric.anti_preferences)  ? rubric.anti_preferences  : [];

  const domains = await Promise.all(domainDefs.map(async d => ({
    name:   d.name || '',
    weight: typeof d.weight === 'number' ? d.weight : 1,
    vec:    await embed(d.description || d.name || ''),
  })));
  const antis = await Promise.all(antiDefs.map(async a => ({
    name: a.name || '',
    vec:  await embed(a.description || a.name || ''),
  })));

  const skills = (Array.isArray(rubric.preferred_skills) ? rubric.preferred_skills : [])
    .map(s => String(s).toLowerCase());
  const languages = (Array.isArray(rubric.programming_languages) ? rubric.programming_languages : [])
    .map(s => String(s).toLowerCase());
  const penalties = (Array.isArray(rubric.penalty_keywords) ? rubric.penalty_keywords : [])
    .map(s => String(s).toLowerCase());

  return { domains, antis, skills, languages, penalties, yoe: rubric.yoe || {} };
}

// ── Score ────────────────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Escape regex metacharacters so skills like "C++" match literally.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score a job against an embedded rubric.
 *
 * domainScore = max over domains of cosine(job, domain) · (weight / maxWeight).
 * Normalizing by the max weight keeps the score in the same range as a raw
 * cosine (the top-weighted domain is undiscounted).
 *
 * Anti-preference penalty is a MARGIN rule: compute the best anti cosine and the
 * best raw (un-weighted) domain cosine, and penalize only when the job looks
 * more like an anti than like any preferred domain. Short-text embeddings live
 * on an unpredictable absolute scale, so we never subtract the raw anti cosine —
 * we just multiply by ANTI_PENALTY.
 *
 * Skill bonus is the fraction of preferred_skills appearing in the JD text
 * (word-boundary, case-insensitive), scaled by SKILL_BONUS_SCALE.
 *
 * YOE gate: if the role title or JD text demands a minimum above yoe.max, the
 * final score is multiplied by YOE_PENALTY (not zeroed — the YOE parsers throw
 * occasional false positives that shouldn't nuke an otherwise good job).
 *
 * @param {object} embeddedRubric  from embedRubric()
 * @param {number[]} jobVec        embedded job text
 * @param {string} jobText         raw job text (for skill match + YOE-from-desc)
 * @param {string} jobRole         job title (for YOE-from-title)
 * @returns {{ score: number, topDomain: string|null, antiHit: string|null, yoeCapped: boolean }}
 */
export function rubricScore(embeddedRubric, jobVec, jobText, jobRole) {
  const { domains, antis, skills, languages = [], penalties = [], yoe } = embeddedRubric;

  // 1 — best preferred domain (weighted for the score, raw for the anti margin)
  const maxWeight = domains.reduce((m, d) => Math.max(m, d.weight), 0) || 1;
  let domainScore = 0, bestRawDomain = 0, topDomain = null;
  for (const d of domains) {
    const raw = cosine(jobVec, d.vec);
    const weighted = raw * (d.weight / maxWeight);
    if (weighted > domainScore) { domainScore = weighted; topDomain = d.name; }
    if (raw > bestRawDomain) bestRawDomain = raw;
  }

  let score = domainScore;

  // 2 — anti-preference margin penalty
  let antiHit = null;
  let bestAnti = 0, bestAntiName = null;
  for (const a of antis) {
    const c = cosine(jobVec, a.vec);
    if (c > bestAnti) { bestAnti = c; bestAntiName = a.name; }
  }
  if (bestAntiName && bestAnti > bestRawDomain) {
    score *= ANTI_PENALTY;
    antiHit = bestAntiName;
  }

  // 3 — skill + programming-language bonuses (literal, word-boundary match).
  // Languages get their own bucket so a Go/Java-heavy JD isn't diluted by a
  // long tools list (and vice versa).
  const lcText = (jobText || '').toLowerCase();
  const keywordFraction = (list) => {
    let hits = 0;
    for (const kw of list) {
      const re = new RegExp(`(?<![\\w+#])${escapeRegex(kw)}(?![\\w+#])`, 'i');
      if (re.test(lcText)) hits++;
    }
    return hits / list.length;
  };
  if (skills.length > 0)    score += keywordFraction(skills)    * SKILL_BONUS_SCALE;
  if (languages.length > 0) score += keywordFraction(languages) * LANG_BONUS_SCALE;
  // Penalty keywords: terms that reliably mark ignored jobs (unlike the noisy
  // positive lists, these are backed by high counts — see rubric.yml).
  if (penalties.length > 0) score -= keywordFraction(penalties) * PENALTY_SCALE;

  // 4 — YOE gate
  let yoeCapped = false;
  if (typeof yoe.max === 'number') {
    const fromTitle = extractMinYOE(jobRole || '');
    const fromDesc  = extractMinYOEFromDesc(lcText);
    const demanded  = Math.max(fromTitle ?? -1, fromDesc ?? -1);
    if (demanded > yoe.max) { score *= YOE_PENALTY; yoeCapped = true; }
  }

  // 5 — clamp
  score = Math.max(0, Math.min(1, score));
  return { score, topDomain, antiHit, yoeCapped };
}
