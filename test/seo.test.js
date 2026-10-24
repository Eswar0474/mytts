import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { createMemoryDailyWordQuota } from '../server/quota.js';

const TITLE = 'Sonora Voice Studio — AI Text to Speech & Audio';
const DESCRIPTION = 'Turn scripts into expressive AI voice narrations with Sonora Voice Studio. Choose a voice, preview speech, and export MP3, WAV, FLAC, AAC, or OGG audio.';
const GUIDE_TITLE = 'How It Works & FAQ — Sonora Voice Studio';
const GUIDE_DESCRIPTION = 'Learn how Sonora Voice Studio turns scripts into expressive AI voice narrations, how per-request word limits work, and how to estimate generation time and export audio.';
const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="theme-color" content="#0b0d12" />
    <!-- seo:head:start -->
    <title>Build-time fallback that must be replaced</title>
    <!-- seo:head:end -->
  </head>
  <body><div id="root">Studio</div><script src="/assets/app.js"></script></body>
</html>`;
const GUIDE_FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="theme-color" content="#0b0d12" />
    <!-- seo:head:start -->
    <title>Build-time guide title that must be replaced</title>
    <!-- seo:head:end -->
  </head>
  <body><main><h1>How it works &amp; FAQ</h1><section id="how-it-works">Write, preview, export.</section><section id="faq">Frequently asked questions.</section></main></body>
</html>`;
const RETIRED_FIXTURE = '<!doctype html><html><body>Stale retired page</body></html>';

async function serve(t, config = {}) {
  const publicDir = await mkdtemp(path.join(tmpdir(), 'sonora-seo-'));
  t.after(() => rm(publicDir, { recursive: true, force: true }));
  await mkdir(path.join(publicDir, 'assets'));
  await writeFile(path.join(publicDir, 'index.html'), FIXTURE);
  await writeFile(path.join(publicDir, 'how-it-works.html'), GUIDE_FIXTURE);
  // Deliberately leave stale assets to prove the retired URLs cannot leak them.
  await writeFile(path.join(publicDir, 'pricing.html'), RETIRED_FIXTURE);
  await writeFile(path.join(publicDir, 'pricing.js'), 'window.staleRetiredAsset = true;');
  await writeFile(path.join(publicDir, 'assets', 'app.js'), 'console.log("studio");');
  await writeFile(path.join(publicDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const app = createApp({
    config: { publicDir, apiKey: 'private-test-key', ...config },
    quotaStore: createMemoryDailyWordQuota({ secret: 'private-quota-secret' }),
    logger: { warn() {}, error() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, publicDir };
}

test('robots and sitemap advertise the configured canonical public pages, including HEAD', async t => {
  const { base } = await serve(t, { siteUrl: 'https://studio.example:8443' });
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
  assert.equal(await robots.text(), 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /profile\nSitemap: https://studio.example:8443/sitemap.xml\n');
  assert.match(robots.headers.get('cache-control'), /max-age=3600/);
  const robotsHead = await fetch(`${base}/robots.txt`, { method: 'HEAD' });
  assert.equal(robotsHead.status, 200);
  assert.equal(robotsHead.headers.get('content-type'), robots.headers.get('content-type'));
  assert.equal(await robotsHead.text(), '');

  const sitemap = await fetch(`${base}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /^application\/xml; charset=utf-8$/);
  const xml = await sitemap.text();
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://studio.example:8443/</loc></url>\n  <url><loc>https://studio.example:8443/how-it-works</loc></url>\n</urlset>\n');
  assert.equal((xml.match(/<loc>/g) || []).length, 2);
  assert.match(xml, /<loc>https:\/\/studio\.example:8443\/how-it-works<\/loc>/);
  assert.doesNotMatch(xml, /pricing/);
  const sitemapHead = await fetch(`${base}/sitemap.xml`, { method: 'HEAD' });
  assert.equal(sitemapHead.status, 200);
  assert.equal(sitemapHead.headers.get('content-type'), sitemap.headers.get('content-type'));
  assert.equal(await sitemapHead.text(), '');
});

test('the guide has a crawlable extensionless URL and page-specific metadata', async t => {
  const { base } = await serve(t, { siteUrl: 'https://studio.example', googleSiteVerification: 'guide-token' });
  const response = await fetch(`${base}/how-it-works`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.match(response.headers.get('cache-control'), /must-revalidate/);
  const html = await response.text();
  assert.ok(!html.includes('Build-time guide title that must be replaced'));
  assert.match(html, /<title>How It Works &amp; FAQ — Sonora Voice Studio<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${GUIDE_DESCRIPTION}" />`));
  assert.match(html, /<link rel="canonical" href="https:\/\/studio\.example\/how-it-works" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/studio\.example\/how-it-works" \/>/);
  assert.match(html, /<meta name="google-site-verification" content="guide-token" \/>/);
  assert.match(html, /<h1>How it works &amp; FAQ<\/h1>/);
  assert.match(html, /id="how-it-works"/);
  assert.match(html, /id="faq"/);
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(match);
  const schema = JSON.parse(match[1]);
  assert.deepEqual(schema['@graph'].map(entry => entry['@type']), ['WebPage', 'FAQPage']);
  assert.equal(schema['@graph'][0].url, 'https://studio.example/how-it-works');
  assert.equal(schema['@graph'][0].description, GUIDE_DESCRIPTION);
  assert.equal(schema['@graph'][1].mainEntity.length, 6);
  assert.equal(schema['@graph'][1].mainEntity[1].name, 'Which models can I use?');
  assert.equal(schema['@graph'][1].mainEntity[0].acceptedAnswer['@type'], 'Answer');
  assert.match(schema['@graph'][1].mainEntity[0].acceptedAnswer.text, /1,000 words with Low Quality, 500 with Balanced, or 250 with Enhanced Thinking/);
  assert.match(schema['@graph'][1].mainEntity[0].acceptedAnswer.text, /Verified admins are exempt from these word limits; character and audio safety limits still apply/);
  assert.match(schema['@graph'][1].mainEntity[0].acceptedAnswer.text, /no daily word or request quota/);
  assert.match(schema['@graph'][1].mainEntity[2].acceptedAnswer.text, /Creating a local account enables all five formats/);

  const extensionRedirect = await fetch(`${base}/how-it-works.html`, { redirect: 'manual' });
  assert.equal(extensionRedirect.status, 301);
  assert.equal(extensionRedirect.headers.get('location'), '/how-it-works');
  const slashRedirect = await fetch(`${base}/how-it-works/`, { redirect: 'manual' });
  assert.equal(slashRedirect.status, 301);
  assert.equal(slashRedirect.headers.get('location'), '/how-it-works');
});

test('retired pricing URLs are gone even when a stale build contains their assets', async t => {
  const { base } = await serve(t, { siteUrl: 'https://studio.example' });
  for (const route of ['/pricing', '/pricing/', '/pricing.html', '/pricing.js']) {
    const response = await fetch(`${base}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
    assert.equal(await response.text(), 'This page is no longer available.');
  }
  const head = await fetch(`${base}/pricing`, { method: 'HEAD' });
  assert.equal(head.status, 410);
  assert.equal(await head.text(), '');
});

test('homepage replaces just marked head with public metadata and safely escaped ownership', async t => {
  const verification = 'token" /><script>alert(1)</script>&\'';
  const { base } = await serve(t, {
    siteUrl: 'https://studio.example', googleSiteVerification: verification, trustProxy: 1
  });
  const response = await fetch(`${base}/`, { headers: {
    Host: 'attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http'
  } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.match(response.headers.get('cache-control'), /must-revalidate/);
  const html = await response.text();
  assert.match(html, /<meta name="theme-color" content="#0b0d12" \/>/);
  assert.match(html, /<body><div id="root">Studio<\/div><script src="\/assets\/app.js"><\/script><\/body>/);
  assert.match(html, /<!-- seo:head:start -->/);
  assert.match(html, /^    <!-- seo:head:end -->/m);
  assert.ok(!html.includes('Build-time fallback'));
  assert.match(html, /<title>Sonora Voice Studio — AI Text to Speech &amp; Audio<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${DESCRIPTION}" />`));
  assert.match(html, /<link rel="canonical" href="https:\/\/studio\.example\/" \/>/);
  assert.match(html, /<meta name="robots" content="index, follow" \/>/);
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.match(html, /<meta property="og:site_name" content="Sonora Voice Studio" \/>/);
  assert.match(html, /<meta property="og:title" content="Sonora Voice Studio/);
  assert.match(html, /<meta property="og:description" content="Turn scripts/);
  assert.match(html, /<meta property="og:url" content="https:\/\/studio\.example\/" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary" \/>/);
  assert.match(html, /<meta name="twitter:title" content="Sonora Voice Studio/);
  assert.match(html, /<meta name="twitter:description" content="Turn scripts/);
  assert.match(html, /<meta name="google-site-verification" content="token&quot; \/&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&#39;" \/>/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('attacker.invalid'));
  assert.ok(!html.includes('private-test-key'));
  assert.ok(!html.includes('private-quota-secret'));
  const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  assert.ok(match);
  const schema = JSON.parse(match[1]);
  assert.equal(schema['@context'], 'https://schema.org');
  assert.deepEqual(schema['@graph'].map(entry => entry['@type']), ['WebSite', 'WebApplication']);
  assert.ok(schema['@graph'].every(entry => entry.name === 'Sonora Voice Studio' &&
    entry.url === 'https://studio.example/' && entry.description === DESCRIPTION));
  assert.equal(schema['@graph'][1].applicationCategory, 'MultimediaApplication');
  assert.equal(schema['@graph'][1].operatingSystem, 'Web');
  assert.equal(schema['@graph'][0]['@id'], 'https://studio.example/#website');
  assert.equal(schema['@graph'][1]['@id'], 'https://studio.example/#application');
  assert.equal(schema['@graph'][1].isPartOf['@id'], schema['@graph'][0]['@id']);
  assert.ok(schema['@graph'].every(entry => !Object.keys(entry).some(key =>
    /^(?:review|aggregateRating|rating|offers?|potentialAction)$/i.test(key))));

  const sitemap = await (await fetch(`${base}/sitemap.xml`, { headers: { Host: 'attacker.invalid' } })).text();
  assert.ok(sitemap.includes('<loc>https://studio.example/</loc>'));
  assert.ok(!sitemap.includes('attacker.invalid'));
});

test('an explicitly blank ownership token omits optional metadata', async t => {
  const original = process.env.SITE_URL;
  delete process.env.SITE_URL;
  t.after(() => { if (original === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = original; });
  const { base } = await serve(t, { googleSiteVerification: '   ' });
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes(`<title>${TITLE.replace('&', '&amp;')}</title>`));
  assert.ok(html.includes('<link rel="canonical" href="https://sonora.rawse.in/" />'));
  assert.ok(!html.includes('google-site-verification'));
  assert.ok((await (await fetch(`${base}/robots.txt`)).text()).includes('Sitemap: https://sonora.rawse.in/sitemap.xml'));
});

test('the configured Search Console token is included when no environment override is set', async t => {
  const original = process.env.GOOGLE_SITE_VERIFICATION;
  delete process.env.GOOGLE_SITE_VERIFICATION;
  t.after(() => {
    if (original === undefined) delete process.env.GOOGLE_SITE_VERIFICATION;
    else process.env.GOOGLE_SITE_VERIFICATION = original;
  });
  const { base } = await serve(t);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<meta name="google-site-verification" content="WKcjy6CTtDshP2gWiMossBKitVn-jvi6uJPzpugyFSE" \/>/);
});

test('SITE_URL env and config.siteUrl give stable origin with config taking precedence', async t => {
  const original = process.env.SITE_URL;
  const originalVerification = process.env.GOOGLE_SITE_VERIFICATION;
  process.env.SITE_URL = 'https://env.example';
  process.env.GOOGLE_SITE_VERIFICATION = 'env-token';
  t.after(() => {
    if (original === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = original;
    if (originalVerification === undefined) delete process.env.GOOGLE_SITE_VERIFICATION;
    else process.env.GOOGLE_SITE_VERIFICATION = originalVerification;
  });
  const { base: fromEnv } = await serve(t);
  const { base: fromConfig } = await serve(t, {
    siteUrl: 'https://configured.example', googleSiteVerification: 'config-token'
  });
  assert.ok((await (await fetch(`${fromEnv}/sitemap.xml`)).text()).includes('<loc>https://env.example/</loc>'));
  assert.ok((await (await fetch(`${fromConfig}/sitemap.xml`)).text()).includes('<loc>https://configured.example/</loc>'));
  assert.ok((await (await fetch(`${fromEnv}/`)).text()).includes('content="env-token"'));
  const configuredHtml = await (await fetch(`${fromConfig}/`)).text();
  assert.ok(configuredHtml.includes('content="config-token"'));
  assert.ok(!configuredHtml.includes('env-token'));
});

test('private routes carry noindex, static assets work, and missing paths never fall back to homepage', async t => {
  const { base, publicDir } = await serve(t, { siteUrl: 'https://studio.example' });
  for (const segment of ['api', 'auth']) {
    await mkdir(path.join(publicDir, segment));
    await writeFile(path.join(publicDir, segment, 'unknown'), 'Must not be served as a private route.');
  }
  const config = await fetch(`${base}/api/config`);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await config.json()).configured, true);
  const auth = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(auth.status, 404);
  assert.equal(auth.headers.get('x-robots-tag'), 'noindex, nofollow');
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(logout.status, 204);
  assert.equal(logout.headers.get('x-robots-tag'), 'noindex, nofollow');

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^(?:text|application)\/javascript;/);
  assert.match(asset.headers.get('cache-control'), /max-age=3600/);
  assert.equal(await asset.text(), 'console.log("studio");');
  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /^image\/svg\+xml/);
  const redirect = await fetch(`${base}/index.html`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/');
  const headRedirect = await fetch(`${base}/index.html`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(headRedirect.status, 301);
  assert.equal(headRedirect.headers.get('location'), '/');
  const headHome = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(headHome.status, 200);
  assert.match(headHome.headers.get('content-type'), /^text\/html;/);
  assert.equal(await headHome.text(), '');

  for (const missing of ['/no-such-page', '/assets/missing.js', '/api/unknown', '/auth/unknown', '/api', '/auth']) {
    const response = await fetch(`${base}${missing}`);
    assert.equal(response.status, 404, missing);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', missing);
    const text = await response.text();
    assert.ok(!text.includes('<html') && !text.includes('Must not be served'), missing);
  }
  const missingHead = await fetch(`${base}/assets/missing.js`, { method: 'HEAD' });
  assert.equal(missingHead.status, 404);
  assert.equal(missingHead.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('invalid or insecure production SITE_URL fails at app creation', () => {
  const quotaStore = createMemoryDailyWordQuota({ secret: 'test-secret' });
  const logger = { warn() {}, error() {} };
  const build = siteUrl => createApp({ config: { siteUrl }, quotaStore, logger });
  for (const value of ['', 'ftp://studio.example', 'https://user:pass@studio.example',
    'https://studio.example/', 'https://studio.example/path', 'https://studio.example?x=1',
    'https://studio.example#section', 'https://studio.example\\@attacker.invalid']) {
    assert.throws(() => build(value), /SITE_URL/, value);
  }
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => build('http://studio.example'), /SITE_URL.*HTTPS/);
    assert.doesNotThrow(() => build('https://studio.example'));
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('a missing or unmarked built homepage fails closed while crawler routes stay available', async t => {
  const { base, publicDir } = await serve(t, { siteUrl: 'https://studio.example' });
  await writeFile(path.join(publicDir, 'index.html'), '<html><head><title>Old title</title></head></html>');
  const unmarked = await fetch(`${base}/`);
  assert.equal(unmarked.status, 503);
  assert.equal(unmarked.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(!(await unmarked.text()).includes('Old title'));
  await rm(path.join(publicDir, 'index.html'));
  const missing = await fetch(`${base}/`);
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  assert.equal((await fetch(`${base}/sitemap.xml`)).status, 200);
});
