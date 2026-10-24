import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// SITE_URL / config.siteUrl is an explicit bare origin, independent of request headers.
// The project's canonical production origin defaults to https://sonora.rawse.in.
export const DEFAULT_SITE_URL = 'https://sonora.rawse.in';
export const DEFAULT_GOOGLE_SITE_VERIFICATION = 'WKcjy6CTtDshP2gWiMossBKitVn-jvi6uJPzpugyFSE';
const TITLE = 'Sonora Voice Studio — AI Text to Speech & Audio';
const DESCRIPTION = 'Turn scripts into expressive AI voice narrations with Sonora Voice Studio. Choose a voice, preview speech, and export MP3, WAV, FLAC, AAC, or OGG audio.';
const GUIDE_TITLE = 'How It Works & FAQ — Sonora Voice Studio';
const GUIDE_DESCRIPTION = 'Learn how Sonora Voice Studio turns scripts into expressive AI voice narrations, how per-request word limits work, and how to estimate generation time and export audio.';
const HEAD_START = '<!-- seo:head:start -->';
const HEAD_END = '<!-- seo:head:end -->';
const NOINDEX = 'noindex, nofollow';

const GUIDE_FAQ = Object.freeze([
  ['How do the word limits work?', 'Guests can submit up to 50 words per request with Low Quality. After creating a local account, each request can contain up to 1,000 words with Low Quality, 500 with Balanced, or 250 with Enhanced Thinking. Verified admins are exempt from these word limits; character and audio safety limits still apply. Whitespace-separated words in the script and delivery tags both count. There is no daily word or request quota. Short-window anti-abuse and server-capacity safeguards still apply.'],
  ['Which models can I use?', 'Guests can use Low Quality. Creating a local account enables Low Quality, Balanced, and Enhanced Thinking. No subscription is required.'],
  ['Which audio formats can I export?', 'Guests can download MP3. Creating a local account enables all five formats: MP3, WAV, FLAC, AAC, and OGG.'],
  ['How long will generation take?', 'An approximate generation time appears above Generate audio before you start. It depends on input length and the selected model, not measured provider performance. A live elapsed timer runs during generation. Actual time varies with language, delivery, network, and provider load.'],
  ['Will tags produce an exact voice delivery?', 'Tags guide delivery, but generated output is not guaranteed to match the requested delivery exactly.'],
  ['Can I generate, preview, or export audio without JavaScript?', 'JavaScript is required for generation, preview, and export.']
]);

function canonicalOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/?#\\]+$/i.test(value)) {
    throw new Error('SITE_URL must be a bare HTTP(S) origin without credentials, path, query, or hash.');
  }
  let url;
  try { url = new URL(value); }
  catch { throw new Error('SITE_URL must be a valid bare HTTP(S) origin.'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
    throw new Error('SITE_URL must be a bare HTTP(S) origin without credentials, path, query, or hash, and use HTTPS in production.');
  }
  return url.origin;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function headMarkup({ title: titleValue, description: descriptionValue, url: urlValue, schema }, verification) {
  const title = escapeHtml(titleValue);
  const description = escapeHtml(descriptionValue);
  const url = escapeHtml(urlValue);
  const ownership = typeof verification === 'string' ? verification.trim() : verification;
  const jsonLd = JSON.stringify(schema).replace(/</g, '\\u003c');
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta name="robots" content="index, follow" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Sonora Voice Studio" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    ...(ownership == null || ownership === '' ? [] :
      [`<meta name="google-site-verification" content="${escapeHtml(ownership)}" />`]),
    `<script type="application/ld+json">${jsonLd}</script>`
  ];
}

function homeSchema(home) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${home}#website`, name: 'Sonora Voice Studio', url: home, description: DESCRIPTION },
      { '@type': 'WebApplication', '@id': `${home}#application`, name: 'Sonora Voice Studio', url: home, description: DESCRIPTION,
        applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', isPartOf: { '@id': `${home}#website` } }
    ]
  };
}

function guideSchema(url) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: GUIDE_TITLE, description: GUIDE_DESCRIPTION, inLanguage: 'en' },
      { '@type': 'FAQPage', '@id': `${url}#faq`, url: `${url}#faq`, mainEntity: GUIDE_FAQ.map(([name, text]) => ({
        '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text }
      })) }
    ]
  };
}

function replaceHead(html, lines) {
  const start = html.indexOf(HEAD_START);
  const end = html.indexOf(HEAD_END);
  if (start < 0 || end < start + HEAD_START.length ||
      html.indexOf(HEAD_START, start + HEAD_START.length) !== -1 ||
      html.indexOf(HEAD_END, end + HEAD_END.length) !== -1) {
    throw new Error('Built index.html must contain exactly one SEO head marker pair.');
  }
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  const prefix = html.slice(html.lastIndexOf('\n', start) + 1, start);
  const indent = /^[ \t]*$/.test(prefix) ? prefix : '';
  return html.slice(0, start + HEAD_START.length) + newline +
    lines.map(line => indent + line).join(newline) + newline + indent + html.slice(end);
}

export function privateNoindex(req, res, next) {
  res.set('X-Robots-Tag', NOINDEX);
  next();
}

export function createSeoRouter({
  publicDir,
  siteUrl = DEFAULT_SITE_URL,
  googleSiteVerification = DEFAULT_GOOGLE_SITE_VERIFICATION,
  logger = console
}) {
  const origin = canonicalOrigin(siteUrl);
  const home = `${origin}/`;
  const guide = `${origin}/how-it-works`;
  const router = express.Router();
  const pages = {
    home: { file: 'index.html', title: TITLE, description: DESCRIPTION, url: home, schema: homeSchema(home) },
    guide: { file: 'how-it-works.html', title: GUIDE_TITLE, description: GUIDE_DESCRIPTION, url: guide, schema: guideSchema(guide) }
  };
  const servePage = page => async (req, res) => {
    try {
      const html = await readFile(path.join(publicDir, page.file), 'utf8');
      const head = headMarkup(page, googleSiteVerification);
      return res.set('Cache-Control', 'public, max-age=0, must-revalidate')
        .type('html')
        .send(replaceHead(html, head));
    } catch (error) {
      logger.error?.(`[sonora] Public ${page.file} is unavailable`, {
        name: error instanceof Error ? error.name : 'UnknownError'
      });
      return res.status(503).set('X-Robots-Tag', NOINDEX).type('text/plain').send('Site is temporarily unavailable.');
    }
  };

  router.get('/robots.txt', (req, res) => res
    .set('Cache-Control', 'public, max-age=3600')
    .type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /profile\nSitemap: ${origin}/sitemap.xml\n`));
  router.get('/sitemap.xml', (req, res) => res
    .set('Cache-Control', 'public, max-age=3600')
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[home, guide].map(url => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n')}\n</urlset>\n`));
  router.get('/index.html', (req, res) => res.redirect(301, '/'));
  router.get('/how-it-works.html', (req, res) => res.redirect(301, '/how-it-works'));
  router.get('/how-it-works/', (req, res, next) => req.path === '/how-it-works/'
    ? res.redirect(301, '/how-it-works')
    : next());
  // Retire old URLs before static serving so stale builds cannot expose the removed page.
  router.all(['/pricing', '/pricing/', '/pricing.html', '/pricing.js'], (req, res) => res.status(410)
    .set('X-Robots-Tag', NOINDEX).type('text/plain').send('This page is no longer available.'));
  router.get('/how-it-works', servePage(pages.guide));
  router.get('/profile', privateNoindex, async (req, res) => {
    try {
      const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
      return res.set('Cache-Control', 'no-store').type('html').send(html);
    } catch (error) {
      logger.error?.('[sonora] Private profile page is unavailable', {
        name: error instanceof Error ? error.name : 'UnknownError'
      });
      return res.status(503).set('X-Robots-Tag', NOINDEX).type('text/plain').send('Profile is temporarily unavailable.');
    }
  });
  router.get('/', servePage(pages.home));
  router.use(['/api', '/auth'], (req, res) => res.status(404)
    .set('X-Robots-Tag', NOINDEX).type('text/plain').send('Not found.'));
  router.use(express.static(publicDir, { index: false, redirect: false, maxAge: '1h' }));
  router.use((req, res) => res.status(404).set('X-Robots-Tag', NOINDEX).type('text/plain').send('Not found.'));
  return router;
}
