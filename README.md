# Face Swap TVC — MiniMax H3 through fal.ai

Based on `Higsfield-Minimax-Working-Version` at `0db0a73`. The master video, selfie processing, page design, face segments, original generation prompt, WAV audio references, normalization, stitching and original final soundtrack are preserved. fal.ai is the only active AI provider; legacy adapter files are not registered or imported.

## Deploy

Deploy `main` on the existing Render service using `render.yaml`. Keep the existing Redis connection, output disk, admin token and campaign limits. Set these server-side environment variables:

```
PROVIDER=falai
FAL_MODEL=minimax/h3/reference-to-video
FAL_RESOLUTION=2K
FACE_SEGMENTS=0-10,26-29
FAL_KEY=<your fal.ai API key>
```

`FAL_KEY` must come from https://fal.ai/dashboard/keys. Higgsfield and MiniMax credentials do not work with fal.ai. Never put the key in frontend code or commit it. Existing Render services must update their environment in the dashboard; editing the blueprint alone does not replace an existing secret. Redeploy after updating the key.

The worker always selects fal.ai even if an old `PROVIDER` value remains in the environment. A different `FAL_MODEL` is rejected to prevent accidentally switching away from H3. Old provider credentials are unused.

The screenshot error `No user found for Key ID and Secret` is an authentication failure before generation. Replace the invalid or revoked fal key; changing the selfie cannot fix it.

## Preserved generation behavior

Each face segment is generated separately with the selfie, source video segment and that window's 16 kHz mono WAV audio. H3 receives the original prompt unchanged. Requested durations round up to whole seconds and are clamped to 5–15 seconds, just like the working branch; the three-second tail renders five seconds and is trimmed back. Output defaults to 2K. fal's `adaptive` aspect setting replaces Higgsfield's `auto`.

The adapter uses fal's `reference_image_urls`, `reference_video_urls` and `reference_audio_urls` fields. It uploads files with their correct MIME types and downloads the generated video for the unchanged FFmpeg pipeline. Audio extraction failure retains the working branch's behavior: log the issue and continue without the audio reference.

H3 regenerates the selected shots, so using the same model and prompt does not guarantee identical output across providers. Check a real render before opening the campaign.

Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAL_PROMPT` | Original working prompt | Prompt override; existing `HF_PROMPT` is accepted for migration |
| `FAL_RESOLUTION` | `2K` | `480P`, `768P`, `2K`, `4K` |
| `FAL_ASPECT` | `adaptive` | Aspect ratio; existing `HF_ASPECT_RATIO` is accepted |
| `FAL_VIDEO_REF` | `1` | Set `0` to omit source video; accepts legacy `HF_VIDEO_REF` |
| `FAL_AUDIO_REF` | `1` | Set `0` to omit audio; accepts legacy `HF_AUDIO_REF` |

## Local development and checks

Install Node.js 22+, FFmpeg and dependencies with `npm install`. Configure `.env` using the server settings above, then `npm run dev`. `QUEUE=redis npm run worker` uses Redis; local development defaults to an in-memory queue.

`npm test` checks the adapter without calling a paid API. `FACE=/path/to/test-selfie.png npm run test:pipeline` runs the real paid pipeline through fal.ai and deletes the supplied test selfie on success; use a disposable copy.

The worker serves the frontend and API together. Keep `web/config.js`'s `WORKER_URL` empty unless hosting the frontend separately. `/health` reports the selected provider. Finished videos live in `/app/outputs` on the Render disk and expire after the configured retention period.

Model schema: https://fal.ai/models/minimax/h3/reference-to-video/api
