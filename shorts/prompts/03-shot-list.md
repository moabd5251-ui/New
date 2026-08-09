# 3. Shot-list prompt

Reconstructed from the video's 8:37 step. In the video this produced a prose
breakdown that you then read by hand while clicking around a video editor. Here
it emits **JSON that the pipeline in this repo consumes directly** — so the
output of this prompt is the input to `npm run make`.

Send this in the same chat, immediately after the script.

````
Break the script above into clip segments and output JSON.

Rules for segmentation:
- Segments are 3-5 seconds. Never shorter than 2.5s (unwatchable) or longer
  than 6s (viewer disengages).
- Cut on meaning, not on a timer. A segment boundary goes where the subject of
  the sentence changes, never mid-clause.
- Segments must tile the whole script with no gaps and no overlaps. The last
  segment's `end` is the total duration.
- Distribute the words by speaking time: ~2.6 words per second.

Rules for `clip`:
- Describe what is literally on screen — subject, action, setting, camera. One
  sentence. Present tense.
- Concrete and filmable. "A grey seal hauls itself across wet sand" is usable.
  "The concept of mimicry in nature" is not.
- It must be findable as real footage. If a shot could only exist as CGI or
  would require a specific named person, place, or event, rewrite it as
  something generic that carries the same meaning.
- No text, captions, charts, or on-screen writing — captions get burned in
  later and will collide.

Rules for `stock_query`:
- 2-4 words, the way you'd type it into a stock footage site. Plain nouns.
- Drop adjectives, camera directions, and abstractions. "seal beach" not
  "cinematic slow motion grey seal".
- Prefer the broadest term that still matches. Stock libraries are shallow;
  a narrow query returns nothing and the pipeline falls back to a colour card.

Rules for `source`:
- "stock" wherever real footage plausibly exists. Default to this.
- "ai" only where real footage almost certainly does not exist.
- At most 2 segments may be "ai".

Output ONLY valid JSON, no markdown fence, matching exactly this shape:

{
  "title": "short working title",
  "topic": "one line describing the subject",
  "voice_script": "the complete script as one string, unchanged from above",
  "segments": [
    {
      "start": 0.0,
      "end": 4.0,
      "text": "the exact words spoken during this segment",
      "clip": "literal visual description of the footage",
      "stock_query": "seal beach",
      "source": "stock"
    }
  ]
}

Concatenating every `text` in order must reproduce `voice_script` exactly,
word for word. Check this before you output.
````

## Using it

Save the output as a `.json` file and run:

```bash
npm run make -- ./my-video.json
```

The pipeline reads `stock_query` to fetch licensed footage, `text` and the
timings to build captions, `voice_script` to generate the voiceover, and
`start`/`end` to cut everything to length.

## Notes

**"Concatenating every text must reproduce voice_script"** is the constraint
that keeps captions in sync. Without it the model paraphrases as it segments,
the caption text drifts from the audio, and the result looks broken in a way
that's hard to trace back.

**The `stock_query` rules exist because stock libraries are much shallower than
TikTok.** This is the real trade-off of sourcing legally: you get a narrower
selection, so the query has to be broad. When nothing matches, the pipeline
renders a titled colour card rather than failing — you'll see it in the output
and can swap in your own footage.

**The 2-segment cap on AI clips** follows the video's own advice, and it's
right for a reason he doesn't give: a Short that's entirely synthetic is
squarely inside YouTube's inauthentic-content policy, and since 2024 realistic
synthetic footage requires disclosure at upload.
