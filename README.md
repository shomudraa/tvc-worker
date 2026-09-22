# Face Swap TVC — MiniMax H3 Max through fal.ai

Based on `Higsfield-Minimax-Working-Version` at `0db0a73`. The master video, selfie processing, page design, face segments, WAV audio references, normalization, stitching and original final soundtrack are preserved. fal.ai is the only active AI provider; legacy adapter files are not registered or imported.

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

The worker always selects fal.ai even if an old `PROVIDER` value remains in the environment. The model is pinned to MiniMax H3 Max in code; stale `FAL_MODEL` values are ignored. Old provider credentials are unused.

The screenshot error `No user found for Key ID and Secret` is an authentication failure before generation. Check which deployment and key the failed request used, and retry a non-generation authentication check before rotating a recently working key. Changing the selfie cannot fix authentication.

## Preserved generation behavior

Each face segment is generated separately with the selfie, source video segment and that window's 16 kHz mono WAV audio. The exact long prompt supplied by the user is sent unchanged, without added instructions. It is pinned in `worker/providers/fal-prompt.js`; stale `FAL_PROMPT` and `HF_PROMPT` values are ignored. Requested durations round up to whole seconds and are clamped to 5–15 seconds, just like the working branch; the three-second tail renders five seconds and is trimmed back. The current comparison uses standard H3 at 2K with prompt_expansion_mode omitted, matching the original working H3 request. fal's `adaptive` aspect setting replaces Higgsfield's `auto`.

The adapter uses fal's `reference_image_urls`, `reference_video_urls` and `reference_audio_urls` fields. It uploads files with their correct MIME types and downloads the generated video for the unchanged FFmpeg pipeline. Audio extraction failure retains the working branch's behavior: log the issue and continue without the audio reference.

H3 regenerates the selected shots, so using the same model and prompt does not guarantee identical output across providers. Check a real render before opening the campaign.

Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAL_PROMPT` / `HF_PROMPT` | Ignored | The approved prompt is pinned in code for this comparison |
| `FAL_RESOLUTION` | `2K` | `480P`, `768P`, `2K`, `4K` |
| `FAL_ASPECT` | `adaptive` | Aspect ratio; existing `HF_ASPECT_RATIO` is accepted |
| `FAL_VIDEO_REF` | `1` | Set `0` to omit source video; accepts legacy `HF_VIDEO_REF` |
| `FAL_AUDIO_REF` | `1` | Set `0` to omit audio; accepts legacy `HF_AUDIO_REF` |

## Local development and checks

Install Node.js 22+, FFmpeg and dependencies with `npm install`. Configure `.env` using the server settings above, then `npm run dev`. `QUEUE=redis npm run worker` uses Redis; local development defaults to an in-memory queue.

`npm test` checks the adapter without calling a paid API. `FACE=/path/to/test-selfie.png npm run test:pipeline` runs the real paid pipeline through fal.ai and deletes the supplied test selfie on success; use a disposable copy.

The worker serves the frontend and API together. Keep `web/config.js`'s `WORKER_URL` empty unless hosting the frontend separately. `/health` reports the selected provider. Finished videos live in `/app/outputs` on the Render disk and expire after the configured retention period.

Model schema: https://fal.ai/models/minimax/h3/reference-to-video/api

## Queue isolation

Redis queues are scoped by Render service ID (`tvc-v3-<service-id>-falai`). Local containers use a separate local queue. This prevents an unrelated container with different credentials or video segments from consuming production jobs when Redis is shared. Previous failed jobs remain in the legacy queue; refresh the page to submit a new job after migration.
