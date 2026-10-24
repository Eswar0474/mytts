---
title: Sonora Voice Studio
emoji: 🎙️
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
short_description: Durable long-audio text-to-speech generation with server-side FFmpeg.
---

# Sonora — Text-to-Audio Studio

React/Vite and Node/Express application with local accounts, durable long-audio jobs, native server-side FFmpeg, a Hugging Face Docker Space deployment, and a separate Supabase PostgreSQL metadata project.

## Run locally

1. Run `npm install`.
2. Create `.env` using `.env.example`. Set `GEMINI_API_KEY` locally. `GEMINI_DEFAULT_MODEL` defaults to the first catalog model; choose a catalog model available to your account. Existing `GEMINI_LIVE_MODEL` settings take precedence for backward compatibility. Never put a key in frontend code or chat.
3. Run `npm run dev`, then visit http://localhost:5173.
4. For a built local preview, run `npm run build` followed by `npm start` and visit http://localhost:8787.
5. Run `npm test` for local chunking, configuration, and WAV-header checks.

During `npm run dev`, Vite proxies `/api`, `/auth`, `/how-it-works`, `/profile`, `/robots.txt`, and `/sitemap.xml` to the Express server. Therefore `http://localhost:5173/how-it-works` opens the standalone guide instead of the React studio fallback. Retired `/pricing` URLs are also forwarded so they return HTTP 410 rather than the studio. A production-style `npm start` serves the same routes directly.

## Hugging Face Docker Space + dedicated Supabase project

This is the deployment path for durable long-audio jobs. The repository includes a Docker Space `README.md` header with `sdk: docker` and `app_port: 7860`, and `Dockerfile` installs native FFmpeg. The server listens on the Space-provided `PORT` and defaults to `7860` in the image.

Create a **new Supabase project** for this deployment instead of reusing the previous project:

1. Create a new Supabase project and copy its PostgreSQL connection string from the database settings.
2. Run `server/migrations/supabase_setup.sql` once in that new project's SQL editor, or let the numbered migrations run when the server connects.
3. Do not create a Supabase Storage bucket for the long audio files. Supabase stores users, sessions, usage, and `audio_jobs` metadata only.
4. In Hugging Face Space Settings, attach persistent storage/Storage Bucket and mount it at `/data`.
5. Add the Space secrets/variables below. Do not commit any of them:

```text
GEMINI_API_KEY=...
DATABASE_URL=postgresql://...from-the-new-supabase-project...
DATABASE_SSL_REJECT_UNAUTHORIZED=false
SESSION_SECRET=long-random-value-at-least-32-characters
DAILY_QUOTA_SECRET=long-random-value
ADMIN_USERNAMES=admin
SITE_URL=https://<your-space-subdomain>.hf.space
PUBLIC_ORIGIN=https://<your-space-subdomain>.hf.space
AUDIO_STORAGE_ROOT=/data/audio
JOB_CONCURRENCY=1
JOB_MAX_RETRIES=3
```

The Docker image uses `PORT=7860`, `HOST=0.0.0.0`, `AUDIO_STORAGE_ROOT=/data/audio`, and native `ffmpeg`. Hugging Face mounts the attached bucket at runtime; the Docker build must not depend on `/data` being present. Final audio is written under `/data/audio/jobs/<job-id>/final.<format>`; only temporary segment files are removed after successful finalization. A completed job is recorded in the new Supabase project's `audio_jobs` table and is downloadable only by its owning local account.

Users must create a local username/password account to use long jobs. `POST /api/jobs` returns immediately with a job id; the worker persists progress after each bounded group of Gemini chunks. The user can close the browser, return to `/profile`, see queued/running/completed history, cancel active jobs, preview completed files, and download them later.

The attached persistent mount is required. Do not use the container's ordinary writable layer for final audio: it is only suitable for temporary files and can be lost when the Space restarts. Configure the Space's storage and billing/retention according to the Hugging Face account that owns the new Space.

## Security boundaries

- Production Express responses send CSP, `nosniff`, frame, referrer, permissions, same-origin resource, and HSTS headers. Google Fonts are not loaded from a third party; the UI uses local/system fallbacks.
- The server accepts only configured public Host values in production (`SITE_URL`, `PUBLIC_ORIGIN`/`PUBLIC_ORIGINS`, and Render's `RENDER_EXTERNAL_URL`). Localhost/loopback Hosts are allowed only outside production. CORS is an origin check, not authentication.
- Guest generation remains intentionally available. Word limits apply independently to every request in both the browser and backend; there is no daily word or request quota. The existing short-window, per-process safeguard allows 12 generation starts per identity per 10 minutes, and the server allows two active generations. These protect capacity, not subscription entitlements. For multiple instances, add equivalent edge/provider rate limits; keep the service behind HTTPS and do not expose a provider key from frontend code.
- PostgreSQL queries use fixed SQL with bound parameters. Database pools reject explicitly non-TLS URI modes and use TLS with certificate verification enabled by default. Both Supabase direct (port 5432) and Supavisor connection poolers (port 6543 / 5432) are supported, with automatic graceful fallback when connection poolers do not support advisory locks. Storage-provider encryption at rest remains a hosting/database responsibility.
- Scripts are sent to Gemini for synthesis but are not stored as raw text in the usage tables. Usage identifiers are HMAC-hashed, and operational errors omit raw database/provider messages, script text, credentials, and connection details from logs. Provider retention is controlled by Google's service/account policy and is not something this proxy can erase.
- Audio and stream limits are separate: PCM has a 128 MiB limit and NDJSON has a larger base64-aware wire limit. Base64 is validated linearly, and whitespace-only chunks are never sent as provider turns.
- Supabase PostgreSQL is used for local users, sessions, usage, and long-job metadata. Large long-job audio artifacts should not be stored in PostgreSQL or the default Supabase database path. Configure `AUDIO_STORAGE_ROOT=/data/audio` in the Hugging Face Docker Space and attach persistent storage there; local development defaults to `./.audio-data`.

## Google Search indexing and submission

The public homepage includes a descriptive title, description, canonical URL, social metadata, WebSite/WebApplication JSON-LD, favicon, and concise guide links. Detailed, no-JavaScript How It Works and FAQ content lives at `/how-it-works`. Both pages have page-specific metadata. Express serves a real `robots.txt` and an XML sitemap listing the homepage and guide. The pricing page, assets, and subscription endpoint have been removed; old pricing URLs return HTTP 410 and are absent from the sitemap. Unknown URLs return 404 instead of an HTTP 200 copy of the studio. API/auth/profile responses carry `X-Robots-Tag: noindex, nofollow`; robots rules also exclude those paths, not JavaScript/CSS assets.

### 1. Deploy the indexing changes

- Deploy as the existing **Node web service**, not a static upload of `dist/`. Build with `npm ci --include=dev && npm run build` and start with `npm start`. Crawler routes and runtime metadata are provided by Express. Keep the `seo:head` marker pair in all public HTML page templates; the server replaces only each page's metadata block, retaining Vite's asset links and public content.
- Set `SITE_URL=https://sonora.rawse.in` in the service environment. This is the project's default and is included in `render.yaml`. For another deployment, set its real production HTTPS origin **without a trailing slash, path, query, or fragment**. The server derives canonical, structured-data, and sitemap URLs from this fixed setting, never the incoming Host header.
- For this custom domain, also set `PUBLIC_ORIGIN=https://sonora.rawse.in` (or the appropriate existing `PUBLIC_ORIGINS` allowlist). `SITE_URL` selects the canonical website; it does **not** change the API's browser-origin allowlist. Keep the database and local-auth session settings configured.
- Restart/redeploy after environment changes. Always use HTTPS. Arrange host-level redirects from noncanonical public domains if needed; the app does not redirect based on untrusted Host headers.

### 2. Verify the public URLs before submitting

Check these URLs on the deployed domain, not just localhost:

| URL | Expected result |
| --- | --- |
| `https://sonora.rawse.in/` | HTTP 200 HTML with the text-to-speech intro, guide links, and the correct homepage canonical URL |
| `https://sonora.rawse.in/how-it-works` | HTTP 200 HTML with the guide/FAQ content and the guide canonical URL |
| `https://sonora.rawse.in/pricing` | HTTP 410; the page was removed |
| `https://sonora.rawse.in/robots.txt` | HTTP 200 `text/plain`, `Allow: /`, exclusions for API/auth/profile, and the absolute sitemap URL |
| `https://sonora.rawse.in/sitemap.xml` | HTTP 200 XML listing only the homepage and guide |
| `https://sonora.rawse.in/index.html` | HTTP 301 redirect to `/` |
| `https://sonora.rawse.in/no-such-page` | HTTP 404, not the studio HTML |

Do not submit while the homepage returns 503, robots disallows the whole site, or robots/sitemap return app HTML. If Render returns 503 before requests reach Express, inspect the deployment/startup logs, `/api/health`, database availability/expiry, and service status. The free service can spin down; reliable hosting availability matters for crawling. These code changes do not change the service plan or repair an upstream hosting outage.

### 3. Verify ownership in Google Search Console

1. Open [Google Search Console](https://search.google.com/search-console) with the Google account that manages the website.
2. Add a **URL-prefix** property for `https://sonora.rawse.in/` (use the actual `SITE_URL` if different).
3. Choose **HTML tag** verification. The provided token is the app's default `GOOGLE_SITE_VERIFICATION` value and is rendered into public page metadata; it is a public ownership token, not an OAuth client secret or API key. For a different property token, set only its content value in the service environment variable `GOOGLE_SITE_VERIFICATION`.
4. Redeploy/restart, confirm that the `google-site-verification` meta tag appears in the homepage's View Source, then click **Verify** in Search Console. Keep the value configured after verification. Alternatively, use Google's DNS verification method if you manage the domain's DNS.

### 4. Submit and monitor

1. In the verified property's **Sitemaps** section, submit `https://sonora.rawse.in/sitemap.xml` (or `sitemap.xml` when the interface already supplies the property prefix).
2. Use **URL Inspection** for `https://sonora.rawse.in/` and `https://sonora.rawse.in/how-it-works`, run **Test live URL**, check that Google can crawl each page, and select **Request indexing**. Do not submit the retired pricing URL.
3. Monitor URL Inspection and the Page indexing report for errors. A `site:` search alone is not a complete indexing diagnostic. Keep the public site available while Google revisits it.

Search Console submission and the production deployment are account-owner actions; local changes do not perform either action. Google controls inclusion, timing, title/snippet selection, and rankings. Requests and sitemaps do not guarantee indexing or a search position, and crawling can take days to weeks. See Google's [recrawl guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) and [sitemap submission guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

Local checks: `node --test test/seo.test.js` exercises crawler routes, metadata/ownership escaping, stable canonicals, private headers, assets, redirects, 404s, and missing-build failures over real HTTP with a fixture. Run `npm test` for all regressions and `npm run build` for the actual Vite output. Then `npm start` serves that build at http://localhost:8787 for a deployment-style check; `npm run dev` alone does not provide the production crawler routes.

## SRS review and necessary clarifications

- The model shortlist below uses IDs from the user's screenshot, not a verified provider model inventory. Availability, supported voices, and generation parameters still need authenticated testing. All entries are marked unverified in the UI; there is no silent model substitution.
- The 1,000,000 limit is an application character limit (JavaScript UTF-16 code units), not a verified Gemini token or context limit. Tokens, characters, output duration, and service quotas are different constraints.
- The installed SDK supports `sendClientContent({ turns, turnComplete: true })` for text-only Live turns. Sonora uses completed content turns for narration so a script is not treated as realtime user activity; `sendRealtimeInput` is reserved for realtime media. Provider-backed verification is still required before production.
- Close code 1008 is a policy violation, not inherently a transient disconnect. Blind reconnection can replay output and repeat authentication failures. This milestone fails closed rather than pretending to resume a session.
- The Live system instruction explicitly treats input as narration and forbids answering or reacting to it. Prompt compliance is not guaranteed by the model; provider-backed audio/transcript acceptance tests are still required.
- Angle brackets and pacing text are preserved, but provider interpretation as pacing controls is not guaranteed. Long tags can cross chunk boundaries.

## Implemented milestone

### Requested Live model catalog

| Model ID | Studio label | Transport | Signed-in words per request | Character safety cap |
| --- | --- | --- | ---: | ---: |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Low Quality | Live | 1,000 | 1,000,000 |
| `gemini-3.8-live` | Balanced | Live | 500 | 65,000 |
| `gemini-3.8-live-extended-thinking` | Enhanced Thinking | Live | 250 | 65,000 |

These are conservative application caps, not claims of unlimited provider rates or quotas. Selecting an engine updates validation on both client and server. Backup selection is manual: failed requests are never automatically replayed on another model. The `gemini-3-flash-live`, `gemini-3.5-live-translate`, and `gemini-3.5-transcribe-live` entries were removed from the selectable catalog after the Live API rejected them as missing/unsupported models or rejected AUDIO output.

All catalog choices use the Live WebSocket path with AUDIO-only setup and sequential completed text turns. The shared system instruction directs each model to narrate the submitted text verbatim rather than answer or act on it; extended-thinking output remains excluded from the response. Live models are conversational by design, so the instruction steers behavior but cannot guarantee perfect verbatim speech. Model availability and speech behavior must be verified against the configured Gemini API account.

Responsive dark studio UI, server-reported model/configuration, full 30-name voice roster, local username/password accounts, profile/history page, job progress polling, authenticated downloads, full 30-name voice roster, word/request and character counters, over-limit blocking, backend-only API key, immutable server instruction, AUDIO-only Live setup, sequential bounded text chunks, multipart audio parsing, timeout/cancellation handling, PCM validation, cancellation, and complete mono 24kHz 16-bit WAV playback. Guests can use the short streaming flow and export MP3. Signed-in users use the durable long-job flow: the server stores job metadata in PostgreSQL, encodes audio with native FFmpeg, and writes final files to the persistent Hugging Face `/data/audio` mount. Browser FFmpeg remains only for the guest/immediate export path.

The `@ffmpeg/core` WebAssembly encoder is licensed under GPL-2.0-or-later. Its [v0.12.10 source](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10) and license must be included or made available as required by that license; satisfy the corresponding-source and notice requirements before distributing this application.

The UI loads `/api/config` without exposing credentials and disables generation until server configuration is present. Configuration presence does not prove model access. Restart the server after changing `.env`, then use **Retry configuration** in the studio.

### Access and informational usage

Guests can use only Low Quality with up to 50 whitespace-separated words per request and MP3 export. Signing in with a local username/password account enables all models and formats, with 1,000 words/request for Low Quality, 500 for Balanced, and 250 for Enhanced Thinking for ordinary accounts. Script and bracketed delivery-tag words both count. Limits update when the model changes and are enforced by the server as well as the message box. There is no daily word or request quota and no subscription is needed. Verified admins are exempt from the word/request caps on all models; short-window anti-abuse, concurrent-generation, character, and audio safety guards remain for everyone.

Admin access requires the username to appear in the `ADMIN_USERNAMES` allowlist and match the current server admin-policy version. The message box and model description show **Admin · no word limit** for the verified session. The HTTP handler derives an internal `bypassWordLimit` boolean from that session and passes it to Live synthesis; body fields or headers cannot grant the exemption. Direct synthesis calls remain word-capped by default. Admin access does not bypass the 1,000,000-character Low safety cap, the 65,000-character Balanced/Enhanced caps, the 5-hour long-job limit, or the 128 MiB immediate-stream audio cap.

The database retains local user records, PostgreSQL sessions, and uncapped usage counts in `daily_word_usage` for reporting. Counts are grouped by UTC day and HMAC-hashed subject, not raw script, IP address, or account password, and are not used to allow or deny generation. Accepted requests count even if synthesis later fails or is cancelled. Configure `DATABASE_URL` for the dedicated Supabase project and a stable `DAILY_QUOTA_SECRET`; its legacy name does not enable a daily quota. Local development can use volatile in-memory counts. Optional usage reads/writes are bounded to 250 ms of waiting; a reporting outage returns no usage metadata rather than blocking synthesis. PostgreSQL-backed local sessions are required for persistent production sign-in.

Migration `server/migrations/005_expand_daily_word_quota.sql` removes the old 1,000-word storage constraint while retaining nonnegative counts, so accumulated usage is no longer rejected with PostgreSQL `23514`. Numbered migrations run on database initialization. Existing user/usage data and legacy database columns are preserved; plan fields no longer affect the application. Behind a reverse proxy, set `TRUST_PROXY` to only trusted proxy IPs/CIDRs; never trust arbitrary forwarded IP headers.

### Generation estimate and timer

An approximate duration is shown above Generate audio before clicking, based on the submitted words, UTF-16 character length, and selected model. `src/timing.js` uses a rough 150 spoken words/minute or 12 characters/second baseline (whichever implies more work), plus startup and estimated 100-word/500-character turn overhead. Model pacing factors are assumptions, not measurements or provider guarantees; language, delivery, network, and provider load can change actual time. Empty scripts have no estimate. The elapsed timer starts with each request, freezes on completion/error/cancel, resets for a new request, and shows an overtime hint rather than claiming completion when the estimate passes.

### Local account setup

The application uses username/password accounts; Google OAuth is not used. Set a long, random `SESSION_SECRET` and configure `DATABASE_URL` so users and sessions persist across restarts and service instances. `POST /api/auth/register` creates an account and starts a session; `POST /api/auth/login` verifies the password; `POST /api/auth/logout` destroys the session. Passwords are stored as salted `scrypt` hashes, never plaintext. Usernames are normalized case-insensitively and must be 3–32 characters using letters, numbers, dots, underscores, or hyphens. Set `ADMIN_USERNAMES` to grant the existing admin word-limit exemption. Never commit `SESSION_SECRET`, database credentials, or password material.

`POST /api/generate/stream` remains the bounded immediate/guest path and streams NDJSON `start`, `audio`, `progress`, `done` events. Signed-in long audio uses `POST /api/jobs`, which returns `202` and a durable job id without holding the browser request open. `GET /api/jobs` and `GET /api/jobs/:jobId` expose only the current user's jobs; `POST /api/jobs/:jobId/cancel` requests cancellation; `GET /api/jobs/:jobId/download` serves only completed files after ownership verification and supports byte ranges for audio playback. The worker persists progress after each bounded group of Gemini Live chunks, resumes stale jobs, retries provider failures, and cleans temporary segment files after successful finalization.

The long-job worker uses native FFmpeg. It encodes each bounded PCM group to a temporary FLAC segment, then concatenates/transcodes those segments to the requested MP3, WAV, FLAC, AAC, or OGG file under `AUDIO_STORAGE_ROOT`. The browser never receives the five-hour PCM stream and never assembles the full long-job WAV.

### Long audio and the 128 MiB cap

The `128 MiB` decoded-PCM and NDJSON limits still apply to the immediate browser-streaming endpoint. They do **not** apply to the durable signed-in long-job path because that path keeps provider audio on the server, sends it incrementally to native FFmpeg, and stores only the final encoded artifact on the persistent Hugging Face mount. A long job is limited to 1,000,000 characters, 60,000 words, and five hours of estimated speech, with one active job per account and one worker by default.

Temporary worker files live under `/data/audio/jobs/<job-id>/segments` and are removed after finalization, cancellation, or terminal failure. Final files live under `/data/audio/jobs/<job-id>/final.<format>`. PostgreSQL stores the script and job metadata needed for recovery; it does not store audio bytes. If the Space restarts, the attached persistent mount retains completed files and the PostgreSQL job row allows queued/running work to be claimed again.

## Remaining work and operational requirements

Provider-backed Gemini voice/model verification, browser listening checks, and measured first-audio latency remain deployment checks rather than local unit-test claims. The durable application flow is implemented, but it requires the real deployment resources: a new Supabase PostgreSQL project, a Hugging Face Docker Space, an attached persistent `/data` mount, `GEMINI_API_KEY`, and native FFmpeg from the Docker image.

The worker intentionally defaults to one active job. Increase `JOB_CONCURRENCY` only after measuring provider quotas, CPU, disk throughput, and storage capacity. Keep the Space's persistent storage attached; ordinary container disk is not the final-artifact location. Back up important audio outside Hugging Face if the files are irreplaceable.

For local development, the server defaults to loopback, restricts browser origins to explicit local addresses, caps immediate synthesis at two requests, and aborts slow immediate-stream clients at a bounded stream buffer. Local account sessions should only be exposed over HTTPS in production.

`render.yaml` is a legacy Render Blueprint and is not the deployment path for the new Hugging Face Space. The Hugging Face deployment uses the Dockerfile and the Space metadata at the top of this file. If the legacy Blueprint is used separately, it requires its own database and secrets.

Guests can generate without an account up to 50 words per request; a local username/password account enables higher per-request limits and all models/formats. Avoid exposing a paid provider key without monitoring provider spend and configuring provider-side safeguards.
