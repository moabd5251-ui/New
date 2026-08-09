# shorts

Build faceless vertical Shorts from a Claude-generated shot list.

This implements the workflow from
["Claude + ChatGPT = $57,152 In 90 Days"](https://www.youtube.com/watch?v=kYPAlvnRiiI),
with one deliberate change: **footage comes from licensed stock libraries
instead of being downloaded off TikTok.** See [Why not TikTok clips](#why-not-tiktok-clips).

It lives in its own directory with its own `package.json` and has nothing to do
with the coupon app in the repo root.

## What's here

```
prompts/     the four prompts the video shows on screen but never reads aloud
src/         the render pipeline
examples/    a working shot list you can run immediately
test/        smoke tests for the paths the example doesn't reach
```

## Quick start

```bash
cd shorts
npm install
npm run example      # renders with placeholder cards, no keys needed
```

That produces a real 1080×1920 MP4 in `out/`. Without API keys the footage is
solid colour cards and the audio is silent — everything else (timing, captions,
encoding, muxing) is exactly what you get in production. It's meant to prove the
pipeline works before you sign up for anything.

Then add keys:

```bash
cp .env.example .env   # fill in what you have
npm run make -- ./my-video.json
```

## The workflow

**1 — Research.** `prompts/01-competitor-research.md`. Pull a competitor's top
performers, ranked by views-per-day rather than raw views. Works with the vidIQ
connector the video uses, or with a hand-pasted list if you'd rather not install
a browser extension.

**2 — Script.** `prompts/02-script.md`. Turns one topic into a ~30-second
voiceover script with a hard word budget.

**3 — Shot list.** `prompts/03-shot-list.md`. Splits the script into timed
segments, each with a visual description and a stock search query. **Outputs
JSON that this pipeline consumes directly.**

**4 — Render.** `npm run make -- shotlist.json`.

**5 — Branding.** `prompts/04-branding.md`. Channel name, logo, banner,
description — plus the mobile safe-area dimensions that AI-generated banners
usually get wrong.

## What the render actually does

1. **Voiceover first.** Its real duration drives everything else. The shot
   list's timings are an estimate from a words-per-second constant; once the
   audio exists, every segment boundary is rescaled to fit it. Skipping this is
   the main reason DIY pipelines drift out of sync partway through.
2. **Footage.** One clip per segment from Pexels/Pixabay, preferring portrait
   and ≥1080 tall. Queries broaden automatically — `grey seal wet sand` →
   `seal wet sand` → `wet sand` → `sand` — because stock libraries are far
   shallower than a social feed. No repeats within a video. Cached to `.cache/`.
3. **Captions.** Burned in via libass: 2–3 word chunks, bold, centred, cycling
   colours, thick outline. Timed by distributing each segment's words across its
   time range in proportion to their length.
4. **Assembly.** Every segment normalised to identical codec/resolution/fps/SAR,
   concatenated, captions burned, voiceover muxed, optional music bed at −18 dB.

Each run also writes `manifest.json` with per-segment timings, which segments
found footage, and the credits to paste into your video description.

### Options

```bash
npm run make -- shotlist.json --music bed.mp3   # background music
npm run make -- shotlist.json --out final.mp4   # output path
npm run make -- shotlist.json --no-stock        # placeholders only, fast
```

## Keys

All optional; the pipeline degrades rather than fails.

| Purpose | Variable | Cost |
|---|---|---|
| Stock footage | `PEXELS_API_KEY` | free |
| Stock footage | `PIXABAY_API_KEY` | free |
| Voice | `ELEVENLABS_API_KEY` | paid, best quality |
| Voice | `OPENAI_API_KEY` | paid, cheaper |
| Voice | `PIPER_MODEL` | free, local, no account |

TTS providers are tried in order and the first one configured wins. With none,
you get a silent track of the right length so the render still completes.

`ELEVENLABS_VOICE_ID` defaults to Adam — the voice the video recommends and the
one most faceless channels use.

## Requirements

Node 18+. ffmpeg ships with the package via `ffmpeg-static`, so there's nothing
to install system-wide.

## Tests

```bash
npm test
```

Covers the real-footage paths the example run never touches: cropping landscape
stock to vertical, looping a clip shorter than its segment, concatenating mixed
real/placeholder segments, timing rescale, and caption tiling.

## Why not TikTok clips

The video's step is: search TikTok for your shot description, copy the video
link, download it, cut it into your Short. It's the fastest way to get footage
and it's the one part of the method I didn't reproduce.

- **Copyright.** Those clips belong to the people who filmed them. Downloading
  and republishing them commercially is infringement, regardless of how short
  the excerpt is or whether the channel is faceless.
- **It breaks the thing being sold.** YouTube's reused-content policy gates
  monetisation on transformation. A compilation of other people's clips with a
  voiceover over the top is the central example of what gets channels rejected
  from the Partner Programme — after you've done the work of getting to the
  threshold.

Pexels and Pixabay licence video for commercial use including monetised YouTube.
The catalogue is narrower, which is why the query ladder exists. Credits are
recorded in `manifest.json` even though neither licence requires attribution.

## Other things the video gets wrong

**"YouTube Shorts isn't saturated — Google Trends is at a 5-year low."** Trends
measures how many people *search* "faceless YouTube", not how many channels are
posting. Declining interest in starting says nothing about the supply already
there.

**The revenue screenshots.** Unverifiable and heavily survivorship-biased. RPMs
for Shorts genuinely have risen; 38¢ on one viral video is not a rate to plan
around.

**"Make it so people don't realise it's AI."** YouTube requires disclosure of
realistic synthetic content at upload. Treating undetectability as the goal is a
policy problem, not a technique. Prompt 03 caps AI-generated clips at 2 per
video for this reason.

**The interesting-facts niche runs on things that are false.** The video's own
example — "katanas are designed to break on purpose" — is a myth. Prompt 02
instructs the model to refuse claims it believes are wrong and offer the
accurate version instead. Leave that clause in.

**Aged channels and "warm-up".** Reusing an old channel and browsing normally
for 30 minutes before posting is harmless, but the trust-score mechanics
described are folklore, not documented behaviour. Don't build a schedule around
it. Verifying your phone number for intermediate features is real and worth
doing.

## Limits

- **No word-level alignment.** Captions are timed proportionally within each
  segment, not aligned to the audio waveform. Accurate at 2–3 words per chunk;
  it would drift on long single-shot segments. Forced alignment (whisper) would
  fix it.
- **No uploader.** Rendering only. YouTube Data API upload is a separate piece.
- **Stock is shallow.** Expect some placeholder cards on unusual topics. They're
  listed in the run output and in `manifest.json` so you can swap footage in.
