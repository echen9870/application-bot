import { fetchJson } from './src/fetch.mjs';

// Smartleaf — verify the board
const sf = await fetchJson('https://api.ashbyhq.com/posting-api/job-board/smartleaf', {timeoutMs:6000});
console.log('Smartleaf Ashby:', (sf.jobs||[]).length, 'jobs');
(sf.jobs||[]).slice(0,3).forEach(j=>console.log(' -',j.title,'|',j.location));

// Fetch the individual Smartleaf job URLs from the search to see if they're still live
for (const id of ['2149fe28-174e-4927-82c2-e8d68530a4dd','ba94ce98-ed60-45e3-a731-662d77be1530']) {
  try {
    const j = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/smartleaf/posting-api/job/${id}`, {timeoutMs:5000,retries:0});
    console.log('Job', id.slice(0,8), ':', j.title||'found');
  } catch(e) {}
}

// Credit Karma — try the Intuit SR slug again and also check if there's a GH board with CK
const ck = await fetchJson('https://boards-api.greenhouse.io/v1/boards/creditkarma/jobs', {timeoutMs:5000});
console.log('\nCredit Karma GH (creditkarma):', (ck.jobs||[]).length, 'jobs');
// Also check the intuit2 SR board for CK jobs
const intuit = await fetchJson('https://api.smartrecruiters.com/v1/companies/intuit2/postings?limit=100&status=PUBLIC', {timeoutMs:6000});
const ckJobs = (intuit.content||[]).filter(j=>j.name?.toLowerCase().includes('credit karma')||j.department?.toLowerCase().includes('credit karma'));
console.log('Intuit SR for CK:', ckJobs.length, 'matching jobs');
ckJobs.slice(0,3).forEach(j=>console.log(' -',j.name));

// AffiniPay — try more GH slugs + their actual site
for (const slug of ['affinipay','affinipayjobs','affinipay-careers','affinipayinc']) {
  const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {timeoutMs:4000,retries:0}).catch(()=>null);
  if (j?.jobs?.length > 0) { console.log(`\n✓ AffiniPay GH: ${slug} (${j.jobs.length})`); break; }
}
// AffiniPay Lever
for (const slug of ['affinipay','affinipayllc']) {
  const j = await fetchJson(`https://api.lever.co/v0/postings/${slug}`, {timeoutMs:4000,retries:0}).catch(()=>null);
  if (Array.isArray(j) && j.length > 0) { console.log(`✓ AffiniPay Lever: ${slug} (${j.length})`); break; }
}
