# TrendCompass — Key Markets

Rendered version of the TrendCompass Key Markets PDF report, plus a cross-check
against the ETF Trend Compass model.

## Files

| File | What it is |
|---|---|
| `data.json` | Per-instrument exposure: price, current/change/new net vote, strategy count |
| `build.py` | Generates the report HTML; holds the 160 per-strategy signal rows |
| `2026-08-20-key-markets.html` | Generated report (self-contained, light + dark) |
| `source-extract.txt` | Raw text extracted from the source PDF, kept for auditing |

## Rebuilding

```
python3 build.py     # writes trendcompass.html next to the script
```

`build.py` asserts on load that every instrument's strategy table cross-foots to
the net total the PDF itself prints, and that `current + change == new` for all
19 markets. A transcription error fails the build rather than reaching the page.

## Known gap

USD/JPY strategy 34 is short, but its label did not survive text extraction from
the PDF; it appears in the report as `(label not in PDF text layer)`. The net
total still reconciles.
