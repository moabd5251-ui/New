# 2. Script prompt

Reconstructed from the video's 8:05 step — the prompt shown on screen but never
read aloud. Open a **new** Claude chat (not the research chat — you don't want
the competitor analysis leaking into the writing), paste this, then paste one
topic summary from step 1 underneath it.

```
Write the voiceover script for a 30-second YouTube Short.

Requirements:

HOOK — The first sentence must be under 8 words and open a curiosity gap or
state something that sounds false but isn't. No greetings, no "in this video",
no "did you know". Start mid-thought, as if the viewer walked in on you already
talking.

LENGTH — 78-88 words. That lands at ~30 seconds of natural narration. Count
them and tell me the count at the end.

STRUCTURE —
  0-3s   hook
  3-20s  the explanation, in escalating order of surprise
  20-27s the single most surprising fact, held back until here
  27-30s a closing line that reframes the hook

STYLE — Short declarative sentences. Average under 12 words. Second person
where natural. Concrete nouns and numbers over adjectives. No rhetorical
questions after the hook. No "imagine if". No summary sentence at the end — end
on the fact, not on a comment about the fact.

ACCURACY — Every factual claim must be one you're confident is true. If the
source topic contains a claim you think is wrong, exaggerated, or a common
myth, do not write it. Say so instead and give me the accurate version.

OUTPUT — The script text only. No headings, no stage directions, no notes.
Then, after the script, one line: "WORDS: n".

Topic:
[paste the SUMMARY from step 1 here]
```

## Notes on why it's shaped this way

**The word count is the load-bearing constraint.** "Write a 30-second script"
gets you 140 words, which is 55 seconds. Word count is the only length
instruction a model follows reliably, and asking it to report the count makes it
actually check.

**"No summary sentence at the end"** — the default behaviour is to close with a
tidy wrap-up ("...which just goes to show how amazing nature is"). That's dead
air in the retention window where viewers decide whether to rewatch. Ending on
the hardest fact is what drives the loop.

**The accuracy clause** matters more than it looks. The interesting-facts niche
runs on things that are widely repeated and false. The video's own example —
"katanas are designed to break on purpose" — is exactly that kind of claim.
Publishing it is a community-notes magnet and, at scale, a channel-trust
problem.

## Follow-up if the first draft is flat

```
The hook is doing too much explaining. Rewrite only the first sentence, 5
different ways, each under 8 words. Make them progressively more specific —
number 5 should name the exact thing, not gesture at it.
```
