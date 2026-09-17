# Face Swap TVC

Visitors upload a selfie and get the client's 30 second TVC back with their face swapped into the seconds where the actor appears. Only the face seconds are sent to the AI provider; everything else stays untouched.

## Status

Day 1 (this repo)
- [x] FFmpeg pipeline: cut master into keep/face pieces, join face pieces into one 10s file, swap once, split back, stitch, watermark, re-attach original audio
- [x] Tested end to end with the mock provider on a synthetic 30s master: output is 30.00s, same resolution and fps, cut points verified frame by frame
- [x] Provider adapter interface (mock, Magic Hour draft, VModel and AKOOL stubs)
- [x] Worker server: Express + BullMQ queue, per IP and daily caps, kill switch, consent record, 24h retention cleanup
- [x] Selfie validation: byte sniffing, EXIF strip, re-encode
- [x] Single page site (web/): upload, preview with consent, rendering state, full screen reveal with download and share, error states, privacy page. Tested in a browser end to end against the mock provider

Next (Claude Code)
- [ ] Verify Magic Hour endpoint paths and response fields against live docs, or swap in the official `magic-hour` SDK
- [ ] Face count + moderation in `worker/validate.js`
- [ ] Signed R2/S3 URLs instead of static `/videos`
- [ ] Cloudflare + Turnstile in front (add the Turnstile widget to the preview panel and verify the token in POST /jobs)
- [ ] Poster image for the background video (`web/poster.jpg`) for slow connections
- [ ] SECURITY.md and data flow diagram

## Run the whole site locally (no Redis, no API key)

```bash
npm install
cp .env.example .env
node scripts/make-test-master.js   # synthetic 30s master, OR copy the real TVC to assets/master.mp4
npm run dev                        # first boot cuts and caches segments (~20s), then prints the URL
```

Open http://localhost:4000 on your computer, or on your phone using your computer's LAN IP. With `PROVIDER=mock` the "swap" tints the face seconds and stamps SWAPPED on them so you can see exactly which frames were touched. Full loop takes about 30s on a laptop.

Real provider: put `MAGIC_HOUR_API_KEY=...` and `PROVIDER=magichour` in `.env`, restart. To test the pipeline without the site: `FACE=./selfie.jpg npm run test:pipeline`.

Production: `QUEUE=redis npm run worker` with `REDIS_URL` set (Upstash works), behind Cloudflare.

## Hosting layout

- Site (static, `web/`): Vercel. Live at https://face-swap-tvc.vercel.app
- Worker (`worker/`, needs FFmpeg and a long running process): Railway, using `railway.json` in this repo

Connect them:
1. Deploy this repo to Railway. Set env vars from `.env.example`, plus `QUEUE=redis`, `REDIS_URL` (Upstash), `PROVIDER`, the provider API key, `ADMIN_TOKEN`, and `SITE_ORIGIN=https://face-swap-tvc.vercel.app`. Upload the real TVC as `assets/master.mp4` (commit it to a private repo or fetch it from R2 at boot).
2. Copy the Railway public URL into `web/config.js` as `WORKER_URL`, redeploy the site to Vercel.
3. Open the site. The footer shows "Rendering service is not connected yet" until step 2 is done.

## Rebranding

Three tokens at the top of `web/styles.css` (`--accent`, `--accent-ink`, `--font`) and the `BRAND` object at the top of `web/app.js`. Copy is in `web/index.html`. Add `assets/watermark.png` to watermark every output.

## Layout

```
web/
  index.html      the single screen
  styles.css      tokens + states
  app.js          upload, poll, reveal, share
  privacy.html    "How this works" notice (fill in the bracketed fields)
worker/
  config.js       env + face timing (FACE_SEGMENTS=0-5,25-30)
  ffmpeg.js       cut / concat / normalize / watermark / mux
  pipeline.js     prepareSegments() once, runSwapJob() per user
  validate.js     selfie checks
  queue.js        memory (dev) or redis (prod) queue, same interface
  server.js       API + site + limits + kill switch + cleanup
  providers/      one adapter per face swap API, same swapVideo() contract
scripts/          test helpers
assets/           master.mp4, segments/ (cached), watermark.png
```

## Pipeline per user

1. `swapVideo(face_joined.mp4, selfie)` -> single provider call (10s)
2. normalize provider output to master size/fps/codec
3. split swapped file back into the face pieces
4. concat: keep and swapped pieces in original order
5. watermark (optional, `assets/watermark.png`)
6. mux original master audio
7. delete selfie immediately, delete output after 24h

## API

- `POST /jobs` multipart: `face` (jpg/png/webp, <=10MB), `consent=true` -> `{jobId}`
- `GET /jobs/:id` -> `{state, videoUrl?}`
- `DELETE /jobs/:id` -> removes the output and consent record
- Kill switch: `POST /admin/pause` with header `x-admin-token: $ADMIN_TOKEN` and body `{"paused":true}`

## Changing the face timing

Edit `FACE_SEGMENTS` in `.env` (e.g. `0-5,25-30`) and rerun `npm run prepare:segments`. Any number of segments works; they are joined into one file so the provider is billed once.
