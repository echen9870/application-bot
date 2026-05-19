import { postJson, fetchText } from './src/fetch.mjs';

// Barclays confirmed
const j = await postJson('https://barclays.wd1.myworkdayjobs.com/wday/cxs/barclays/External_Career_Site/jobs',
  {appliedFacets:{},limit:1,offset:0,searchText:''},{timeoutMs:6000,retries:0});
console.log(`✓ Barclays: barclays.wd1/External_Career_Site (${j?.total||0})`);

// Cashapp / Block
const block = await fetchText('https://block.xyz/careers', {timeoutMs:8000}).catch(()=>'');
const wdM = block.match(/([a-z0-9]+)\.wd\d+\.myworkdayjobs\.com\/([A-Za-z0-9_-]+)/i);
const ghM = block.match(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9]+)/i);
const ashby = block.match(/jobs\.ashbyhq\.com\/([a-z0-9]+)/i);
console.log('Block WD:', wdM?.[0], 'GH:', ghM?.[1], 'Ashby:', ashby?.[1]);

// IMC - try their greenhouse board directly
for (const slug of ['imc','imctrading','imc-trading']) {
  const j = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`).then(r=>r.json()).catch(()=>null);
  if (j?.jobs?.length) { console.log(`✓ IMC GH: ${slug} (${j.jobs.length})`); break; }
  // Try Ashby
  const a = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`).then(r=>r.json()).catch(()=>null);
  if (a?.jobs?.length) { console.log(`✓ IMC Ashby: ${slug} (${a.jobs.length})`); break; }
}

// Morningstar Workday guesses
for (const [s, site] of [['wd5','External'],['wd3','morningstar'],['wd1','Morningstar']]) {
  try {
    const j2 = await postJson(`https://morningstar.${s}.myworkdayjobs.com/wday/cxs/morningstar/${site}/jobs`,
      {appliedFacets:{},limit:1,offset:0,searchText:''},{timeoutMs:4000,retries:0});
    if (j2?.total > 0) { console.log(`✓ Morningstar: morningstar.${s}/${site} (${j2.total})`); break; }
  } catch {}
}

// Pega guesses
for (const [t,s,site] of [
  ['pegasystems','wd3','External'],['pegasystems','wd5','Pegasystems'],
  ['pega','wd3','External'],['pega','wd1','Pega'],
]) {
  try {
    const j3 = await postJson(`https://${t}.${s}.myworkdayjobs.com/wday/cxs/${t}/${site}/jobs`,
      {appliedFacets:{},limit:1,offset:0,searchText:''},{timeoutMs:4000,retries:0});
    if (j3?.total > 0) { console.log(`✓ Pega: ${t}.${s}/${site} (${j3.total})`); break; }
  } catch {}
}
