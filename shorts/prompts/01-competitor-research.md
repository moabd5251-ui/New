# 1. Competitor research

Reconstructed from the video's step 2. The video used the **vidIQ for Claude**
connector, whose "Competitor breakdown" button injects its own prompt text — so
that block is vidIQ's, not something you type. What follows is the useful part:
the questions you ask *after* the breakdown lands, plus a connector-free
fallback.

## Setup (as shown in the video)

1. Install the **vidIQ Chrome extension** (free).
2. Open Claude, refresh the tab, click the vidIQ dropdown → **Connect YouTube
   Insights**.
3. In Claude: `+` → Connectors → **Add from vidIQ for Claude** → **Competitor
   breakdown**.
4. Get the channel ID: on the channel page → **More** → **Share channel** →
   **Copy channel ID**. Paste it in, click **Add prompt**, send.

The video says to hit "always allow" on the permission prompts. Understand what
you're granting before you do — "always allow" is a standing grant to that
connector for the rest of the conversation, not a one-time click.

## Follow-up prompt (the one that actually matters)

```
From the breakdown above, give me the 5 highest-performing video topics on this
channel.

For each one:
- TITLE: the original video title
- LINK: the video URL
- VIEWS: view count and how long ago it was posted
- HOOK: the first line or visual, as literally as you can reconstruct it
- SUMMARY: 3-4 sentences on what the video actually explains, with the specific
  facts it uses — enough detail that I could rewrite the script from scratch
  without rewatching it
- WHY IT WORKED: one sentence on the specific curiosity gap or tension driving
  the retention

Rank by views-per-day-since-posting, not raw views, so recent breakouts aren't
buried under old videos.

Skip anything that's a duplicate topic of a higher-ranked entry.
```

That last instruction matters. Raw view counts bias toward whatever is oldest on
the channel, which is the opposite of what you want — you're looking for what's
working *now*.

## Fallback without the connector

If you'd rather not install a Chrome extension and grant it access, paste 10–20
of the channel's video titles and view counts in by hand:

```
Here are the last 20 videos from a YouTube Shorts channel in the
interesting-facts niche, with view counts:

[paste: title — views — date, one per line]

Analyse this list:

1. Which 5 topics massively outperformed the channel's median? Give the median
   first so I can see the baseline.
2. What do the outliers have in common that the median videos don't — subject
   matter, title structure, promise, emotional register?
3. Name the specific curiosity gap each outlier opens in its title.
4. Give me 10 new topic ideas that exploit the same gap structure but are not
   the same subject. For each, write the title as it would appear on YouTube.

Be blunt about weak patterns. If the outliers look like luck rather than a
repeatable structure, say so instead of inventing a pattern.
```

The final line is there on purpose. Given a list of numbers and asked to find a
pattern, a model will find one whether or not it exists — you have to give it
permission to say "this is noise."
