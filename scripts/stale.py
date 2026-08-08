"""Make a dashboard admit, on its own face, when its numbers have gone old.

Every page here is static HTML built from a snapshot. When the routine behind one stops
running — a deleted environment, a paused trigger, a failed push — the page keeps serving
the last snapshot indefinitely and looks exactly as authoritative as it did on the day it
was built. That is not hypothetical: the volatility-ramp page went on showing an NVDA 205
calendar for four days after its routine died. The strike was at the money when built and
8% away by the time it was read, and nothing on the page said so.

A generator cannot solve this, because it cannot know how long its output will sit on a
screen. The check has to happen when the page is READ, so the age is computed in the
reader's browser against a build time baked into the HTML.

Thresholds are in trading terms rather than round numbers: under 18 hours covers the same
session and the next morning, so an overnight read stays quiet. Past that, option prices
and implied vols have moved enough to matter. Past three days a strike chosen at the money
is very likely no longer near it, which is a different and worse kind of wrong — so the
message stops hedging and says the page is not updating.
"""

CSS = """
.stale{padding:13px 17px;margin-bottom:20px;border-radius:0 2px 2px 0;font-size:13.5px;
  color:var(--ink);background:color-mix(in srgb,var(--stop) 14%,transparent);
  border-left:3px solid var(--stop)}
.stale b{color:var(--stop)}
"""

DIV = '<div class="stale" id="stale" hidden></div>'

_JS = """
(function(){
  var built = new Date(%BUILT%), now = new Date();
  var hrs = (now - built) / 3600000;
  if (hrs < 18) return;                       // same session, or the next morning
  var el = document.getElementById('stale');
  if (!el) return;
  var days = Math.floor(hrs / 24);
  var age = days >= 1 ? (days + (days === 1 ? ' day' : ' days')) : (Math.floor(hrs) + ' hours');
  var msg = hrs >= 72
    ? '<b>This page is ' + age + ' old and is not updating.</b> Levels were chosen against '
      + 'the price on the build date and the underlying has almost certainly moved away '
      + 'from them since. Every price, expiry and structure below should be treated as a '
      + 'historical snapshot, not a current trade.'
    : '<b>This page is ' + age + ' old.</b> Prices and implied vols move daily, and the '
      + 'levels shown were set against the build-date price. Re-check against a live book.';
  el.innerHTML = msg;
  el.hidden = false;
})();
"""


def js(built):
    """The staleness check, pinned to `built` (a timezone-aware datetime)."""
    import json
    return _JS.replace("%BUILT%", json.dumps(built.strftime("%Y-%m-%dT%H:%M:%SZ")))
