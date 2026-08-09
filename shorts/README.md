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

**5 — Upload.** `npm run upload -- out/<slug>`. See [Uploading](#uploading).

**6 — Repeat on a timetable.** `npm run schedule -- add <shot-list.json>` and
let cron post it. See [Scheduling](#scheduling).

**Branding**, separately and once: `prompts/04-branding.md`. Channel name, logo,
banner, description — plus the mobile safe-area dimensions that AI-generated
banners usually get wrong.

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

## Uploading

> **Read [Verification](#verification--read-this-before-you-rely-on-it) first.**
> On a fresh Google Cloud project, everything you upload through this API is
> permanently locked to private. That is not a bug in this tool and it cannot
> be appealed.

One-time setup:

1. Google Cloud Console → new project → enable **YouTube Data API v3**.
2. Credentials → Create credentials → OAuth client ID → **Desktop app**.
3. Put the client ID and secret in `.env`.

```bash
npm run auth                                   # once per channel
npm run upload -- out/my-video --dry-run       # see exactly what would be sent
npm run upload -- out/my-video                 # uploads as private
```

Point it at a render directory and it reads `manifest.json` to fill in the
title, the description with footage credits, and the synthetic-media
disclosure. Explicit flags win over anything inferred.

```bash
npm run upload -- out/my-video \
  --title "Why seals copy you" \
  --description "New facts every day." \
  --tags seals,animals,facts \
  --privacy public --yes
```

| Flag | Effect |
|---|---|
| `--privacy` | `private` (default), `unlisted`, `public` |
| `--yes` | required for anything other than private |
| `--publish-at <iso>` | schedule; requires `--privacy private` |
| `--category <name>` | `education` (default), `science`, `entertainment`, … |
| `--synthetic` / `--no-synthetic` | force the AI-content disclosure on or off |
| `--made-for-kids` | sets `selfDeclaredMadeForKids` |
| `--no-credits` | omit the footage credits block |
| `--dry-run` | print the exact API request body and stop |

Uploads default to **private** and refuse to go public without `--yes`, because
an upload is a publish — once it's indexed, deleting it doesn't fully undo it.

Uploads are resumable and chunked, so a dropped connection resumes from the
last confirmed byte instead of restarting and burning a second upload's worth of
quota.

### Quota

`videos.insert` costs **1600 units** against a default **10,000/day** — about
**six uploads per day**, resetting at midnight Pacific. The video's advice to
post 1–2 per day fits inside that comfortably. You can request more in the Cloud
Console at no cost.

### Synthetic content disclosure

`status.containsSyntheticMedia` is set automatically:

- **AI-generated clips** — unambiguous. YouTube lists "generating realistic
  scenes" as requiring disclosure.
- **AI voiceover** — ambiguous. YouTube's example list includes "synthetically
  generating a person's voice to narrate a video" under *using the likeness of a
  realistic person*, which is commonly read as applying only to impersonating a
  specific real person, not to a generic TTS narrator. **This tool discloses
  anyway.** A label costs a little reach; an undisclosed-synthetic strike costs
  the channel. Override with `--no-synthetic` if you've made a different call.

## Scheduling

Posting daily is the part of the video's advice that's actually load-bearing,
and it's the part that fails first when you're doing it by hand.

```bash
npm run schedule -- add examples/*.json    # queue shot lists
npm run schedule -- plan                   # what posts when
npm run schedule -- tick --dry-run         # preview, change nothing
npm run schedule -- tick --yes             # do what's due
```

Then hand `tick` to cron and stop thinking about it:

```
*/15 * * * * cd /path/to/shorts && npm run schedule -- tick --yes >> schedule.log 2>&1
```

`npm run schedule -- watch` does the same in the foreground if you'd rather not
touch crontab, but cron survives reboots and watch doesn't.

### Two modes

**`drip`** holds the upload until the slot arrives and posts it then, with
whatever privacy you configured. Needs a live cron at that moment, but nothing
is on YouTube's servers until you mean it. This is what `.env.example` ships
with, paired with `private` — see [Verification](#verification--read-this-before-you-rely-on-it)
for why that's the honest setting until your API project is audited.

**`publish-at`** uploads the video early as private with a `publishAt`
timestamp, and YouTube flips it public at the slot. Nothing needs to be running
at post time — a laptop that's closed at 09:00 still posts at 09:00. Worth
switching to once the audit clears; before then it schedules a publish that
never fires.

```bash
SCHEDULE_SLOTS=09:00,18:00     # local times of day
SCHEDULE_MAX_PER_DAY=2
SCHEDULE_MODE=drip             # or publish-at
SCHEDULE_PRIVACY=private       # drip only
SCHEDULE_QUOTA_BUDGET=10000    # raise if Google granted you more
SCHEDULE_YES=true              # standing consent, instead of --yes each run
```

### How tick behaves

**Rendering always runs; uploading is gated.** Rendering costs nothing but CPU,
so a queued video is built and inspectable well before its slot. Uploading is
the irreversible half and needs `--yes` whenever the configuration ends up
public.

**Missed slots move forward.** If the machine was asleep or a run failed, jobs
don't sit with a timestamp in the past — they're reassigned to the next free
slot. In `publish-at` mode this is not cosmetic: the API rejects a `publishAt`
in the past outright.

**Quota is tracked against the Pacific day**, because that's when YouTube resets
it — not local midnight. Bucketing by local date would let a run just after
local midnight double-spend the same quota day. At 1600 units an upload, `tick`
stops at six and picks up after the reset.

**Failures retry three times, then stop.** A job that can't render or upload is
marked `failed` and left alone rather than retried every 15 minutes forever.
`npm run schedule -- retry <id>` puts it back.

**Slots are never double-booked**, and a slot that passed unused doesn't eat
that day's cap — a missed morning post doesn't cost you the evening one.

## Verification — read this before you rely on it

**Videos uploaded through a Google Cloud project that has not passed YouTube's
API audit are locked to private. Permanently. There is no appeal, and the fix
is to re-upload through a verified project or through the YouTube app.**

This applies to every project created after 28 July 2020, which means every
project you would create today. Nothing in this tool — or any other API
uploader — changes it.

Practical consequences:

- The `--privacy public` flag will appear to work and the video will still come
  back private. The CLI detects this and tells you.
- Plan for one of two paths: **apply for the API audit** through the Cloud
  Console and wait for approval, or **use this to stage private uploads** with
  the metadata filled in and hit publish yourself in YouTube Studio.
- The staging path is honestly fine for 1–2 videos a day. The audit is worth it
  only once you're posting enough that manual publishing is the bottleneck.

I'd rather you know this before building a posting habit around a pipeline that
can't publish.

## Keys

All optional; the pipeline degrades rather than fails.

| Purpose | Variable | Cost |
|---|---|---|
| Stock footage | `PEXELS_API_KEY` | free |
| Stock footage | `PIXABAY_API_KEY` | free |
| Voice | `ELEVENLABS_API_KEY` | paid, best quality |
| Voice | `OPENAI_API_KEY` | paid, cheaper |
| Voice | `PIPER_MODEL` | free, local, no account |
| Upload | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | free |

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

34 tests, no network and no credentials needed.

`test/smoke.js` covers the real-footage paths the example run never touches:
cropping landscape stock to vertical, looping a clip shorter than its segment,
concatenating mixed real/placeholder segments, timing rescale, caption tiling.

`test/upload.js` covers the uploader's arithmetic and rules: resumable chunk
ranges (inclusive `end`, exact tiling), `308` resume offsets, metadata limits,
`publishAt` constraints, description assembly, and the synthetic-media
decision.

`test/schedule.js` covers slot assignment against fixed clocks — per-day caps,
double-booking, missed slots, rescheduling the past — and quota accounting
across the midnight-Pacific boundary. Every case pins an explicit time; a
scheduler that only passes between 9am and 6pm isn't tested.

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
- **Uploads can't be public on an unaudited project.** See
  [Verification](#verification--read-this-before-you-rely-on-it). This is a
  YouTube policy, not something the code can work around.
- **The scheduler needs something to run it.** `tick` is a single pass designed
  for cron; it is not a daemon. `watch` is a convenience, not a service.
- **Stock is shallow.** Expect some placeholder cards on unusual topics. They're
  listed in the run output and in `manifest.json` so you can swap footage in.
