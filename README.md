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

## Higgsfield provider (`PROVIDER=higgsfield`)

Uses the Higgsfield Open API, model `minimax/h3/reference-to-video`. Get a key at https://open.higgsfield.ai/api-keys and set:

```
PROVIDER=higgsfield
HF_KEY=KEY_ID:KEY_SECRET
```

Optional:

| Var | Default | What it does |
| --- | --- | --- |
| `HF_MODEL` | `minimax/h3/reference-to-video` | any Higgsfield model id with the same input shape |
| `HF_PROMPT` | see `worker/providers/higgsfield.js` | the generation prompt, this is the main quality lever |
| `HF_RESOLUTION` | `2K` | only option H3 offers today |
| `HF_ASPECT_RATIO` | `auto` | `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `HF_VIDEO_REF` | `1` | `0` sends the selfie only, without the original segment |
| `HF_AIGC_WATERMARK` | `0` | `1` lets Higgsfield stamp its AI watermark |
| `HF_POLL_SECONDS` | `900` | how long to wait for one render |

Three things to know before this goes to the client:

1. **H3 regenerates, it does not edit.** Magic Hour Character Replace keeps the master's frames and swaps the performer. H3 reads the references and renders a new clip that resembles them. The swapped seconds will look close to the TVC, not identical to it. Check the cut against the untouched seconds on real footage first.
2. **References travel as URLs.** The segment and the selfie are pushed to Higgsfield's CDN (`POST /files/generate-upload-url`, then a PUT). The returned URL is unguessable but public, and there is no delete endpoint, so assume the selfie and the output sit there for at least seven days. `web/privacy.html` needs a line saying so.
3. **Minimum render is 5 seconds.** H3 takes whole seconds from 5 to 15. The 26 to 29s segment is 3 seconds, so it is rendered at 5 and trimmed back. You pay for 5.

Cost at the listed `$0.13` per 2K second: the 10s segment plus the 5s minimum on the tail segment is about `$1.95` per visitor. Confirm against your own dashboard rate before opening the campaign.

Production: `QUEUE=redis npm run worker` with `REDIS_URL` set (Upstash works), behind Cloudflare.

## Hosting layout

One service on Render. The worker serves the site itself (`express.static(web/)`), so the page and the API share one origin. There is no separate frontend host, no CORS, and nothing to wire together.

1. In Render, click **New > Blueprint** and point it at this repo. It reads `render.yaml`, builds from the `Dockerfile` (which installs FFmpeg) and asks you for the secrets marked `sync: false`: `REDIS_URL` (Upstash), `HF_KEY`, `ADMIN_TOKEN`. Check that `PROVIDER` and `FACE_SEGMENTS` match what you want.
2. Upload the real TVC as `assets/master.mp4` (commit it to this repo, or fetch it from R2 at boot).
3. Open the Render service URL. That is the live site.

Leave `WORKER_URL` empty in `web/config.js` and leave `SITE_ORIGIN` unset. Both exist only for the case where the site is hosted somewhere separate from the worker, which is not this setup.

Two Render specifics that bite:

- **Do not use the free instance type.** It sleeps when idle. A sleeping worker drops renders that are still in flight, and the first visitor of the day waits through a cold start.
- **Keep the disk.** Render's filesystem is wiped on every deploy. The blueprint mounts a disk at `/app/outputs` so finished videos survive a redeploy. Without it, anyone who has not downloaded yet loses their video the next time you push.

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
