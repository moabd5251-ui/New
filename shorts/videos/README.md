# First six videos — animal behaviour

Ready to render. Queue them all:

```bash
npm run schedule -- add videos/*.json
npm run schedule -- plan
```

Or build one on its own to look at it first:

```bash
npm run make -- videos/01-crows-remember-faces.json
```

At the configured 2/day these cover three days.

## Sources

The interesting-facts niche runs on things that are widely repeated and false —
the video that inspired this pipeline uses "katanas are designed to break on
purpose" as an example topic, which is a myth. So every claim here is written
down with where it comes from, and with how confident I actually am.

Check anything marked **worth verifying** before you publish it.

### 01 — Crows remember your face
Marzluff et al., University of Washington. Researchers wore a distinctive mask
while trapping and banding crows, then walked the campus wearing it for years
afterwards. Scolding and mobbing persisted, spread to crows that had never been
trapped, and increased over time.
*Confident.* Well replicated, widely reported, and the horizontal-transmission
result is the published finding, not a press embellishment.

### 02 — Bees headbutt to end an argument
Seeley et al., *Science* (2012), on stop signals and cross-inhibition in swarm
decision-making. Scouts dancing for a competing nest site deliver brief
vibrational signals to rival dancers, which causes them to stop. This breaks
deadlock and lets the swarm reach quorum.
*Confident.* This is the central result of the paper.

### 03 — Vampire bats keep a ledger
Wilkinson (1984) on reciprocal food sharing; Carter & Wilkinson (2013) showing
past donations predict future ones better than relatedness does; later work on
relationships built through grooming before food is risked.
*Confident* on the reciprocity and the two-night starvation window.
*Worth verifying:* the specific claim that newcomers are tested with grooming
first, then small donations — the escalation is documented, but I've stated it
more crisply than the literature does.

### 04 — Sea otters keep a favorite rock
Sea otters have a loose pouch of skin under each foreleg used to hold food and a
stone, and they use stones as anvils to open shellfish.
*Confident* on the pouch and the anvil use — both long documented.
**Worth verifying:** "keep the same one for years." This is very widely repeated
by aquariums and nature programmes, and I could not tie it to a specific study.
If you can't source it, change the line to "Otters reuse the same one" and the
video still works.

### 05 — Ants farm aphids
Long-established. Ants stroke aphids to induce honeydew release, defend them
from predators including ladybugs, and move them between host plants. Oliver et
al. (2007) on ant semiochemicals in the trail limiting winged-aphid dispersal.
*Confident* on tending, defence, transport, and the chemical effect.
*Worth verifying:* wing removal is documented but is species-specific, not a
general ant behaviour. The script says "some species go further", which is the
honest framing — keep that qualifier if you edit the line.

### 06 — Pigeons can tell a Monet from a Picasso
Watanabe, Sakamoto & Wakita (1995), *Journal of the Experimental Analysis of
Behavior*. Pigeons trained to discriminate Monet from Picasso generalised to
paintings neither they nor the training set had included, and to other
impressionist and cubist painters they'd never been trained on. Won an Ig Nobel,
which is a marker of being real and funny, not of being wrong.
*Confident.*

## Notes on the writing

Scripts are 78–80 words, which lands near 30 seconds at Shorts narration pace.
Every hook is 7–8 words and none of them explains anything — the explanation
starts in segment two.

Each one ends on the hardest fact rather than a summary line. "It is a ledger",
"they cannot go", "they had learned a style". The wrap-up sentence a model
writes by default is dead air in exactly the window where a viewer decides
whether to rewatch.

Spelling is American in the scripts because captions are burned in and the
audience skews US — this differs deliberately from the British spelling used in
the code and comments.

Stock queries are broad on purpose (`crow closeup`, not `American crow head
turning`). Animals are the deepest category in the free stock libraries, which
is why this niche was picked first; expect most segments to find real footage.
Anything that doesn't gets a placeholder card, listed in the run output and in
`manifest.json`.
