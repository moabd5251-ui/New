import { VIDEO } from './config.js';

/**
 * Burned-in captions, built as ASS and rendered by libass.
 *
 * This build of ffmpeg has no drawtext filter, so libass does all text. That's
 * the better tool anyway — it handles wrapping, outlines and per-line colour
 * without a filter graph per caption.
 *
 * Timing note: we don't have word-level alignment (that would need forced
 * alignment against the audio). Instead we distribute each segment's words
 * across that segment's time range in proportion to their length. For 2-4 word
 * chunks at Shorts pace this is accurate to well under a syllable, and it
 * stays locked to the segment boundaries the shot list already defines.
 */

// The "random colour" caption style the video recommends — bright, saturated,
// high contrast against arbitrary footage.
const PALETTE = ['#FFFFFF', '#FFE23D', '#4DFF7A', '#3DE1FF', '#FF5EC4', '#FF9E3D'];

/** ASS colours are &HBBGGRR, not RGB. Getting this backwards is the classic bug. */
function toAssColour(hex) {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  const cc = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

function escapeAss(text) {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

/**
 * Group a segment's words into caption chunks. Two constraints fight here:
 * more words per chunk means less flicker, fewer means better pacing. 3 words
 * / 18 characters is the balance most high-retention Shorts land on.
 */
function chunkWords(text, { maxWords = 3, maxChars = 16 } = {}) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word];
    const length = candidate.join(' ').length;
    if (current.length && (candidate.length > maxWords || length > maxChars)) {
      chunks.push(current.join(' '));
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export function buildAss(segments, options = {}) {
  const {
    fontName = process.env.CAPTION_FONT || 'Liberation Sans',
    fontSize = 104,
    uppercase = true,
    outline = 7,
    shadow = 2,
    // Alignment 5 is middle-centre. Shorts captions sit slightly above centre
    // so they clear the title/handle overlay at the bottom of the feed UI.
    alignment = 5,
    marginV = 0,
  } = options;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${VIDEO.width}`,
    `PlayResY: ${VIDEO.height}`,
    // WrapStyle 0 wraps long chunks onto a second line. WrapStyle 2 disables
    // wrapping entirely, which lets a long word run off both edges of a 1080
    // frame — silent, and only visible once you look at a rendered frame.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Pop,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},90,90,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  let colourIndex = 0;

  for (const segment of segments) {
    const chunks = chunkWords(segment.text || '');
    if (!chunks.length) continue;

    const span = Math.max(0.1, segment.end - segment.start);
    const totalWeight = chunks.reduce((sum, c) => sum + Math.max(2, c.length), 0);

    let cursor = segment.start;
    chunks.forEach((chunk, i) => {
      const weight = Math.max(2, chunk.length) / totalWeight;
      const isLast = i === chunks.length - 1;
      const end = isLast ? segment.end : cursor + span * weight;
      const colour = toAssColour(PALETTE[colourIndex % PALETTE.length]);
      colourIndex += 1;

      const body = uppercase ? chunk.toUpperCase() : chunk;
      // Short fade plus a quick scale-up reads as "pop" without being busy.
      const effects = `{\\fad(40,40)}{\\c${colour}}{\\fscx88\\fscy88\\t(0,110,\\fscx100\\fscy100)}`;
      events.push(
        `Dialogue: 0,${assTime(cursor)},${assTime(end)},Pop,,0,0,0,,${effects}${escapeAss(body)}`
      );
      cursor = end;
    });
  }

  return `${[...header, ...events].join('\n')}\n`;
}

/**
 * Rescale planned segment timings onto the voiceover's real duration.
 *
 * The shot list's timings are an estimate from a words-per-second constant.
 * Once the real audio exists we know the truth, so everything gets stretched
 * or compressed to fit. Without this the captions drift further out of sync
 * with every segment, which is the single most visible way these videos break.
 */
export function fitToAudio(segments, actualDuration) {
  const planned = segments.length ? segments[segments.length - 1].end : 0;
  if (!planned || !actualDuration) return segments.map((s) => ({ ...s }));
  const factor = actualDuration / planned;
  return segments.map((s) => ({
    ...s,
    start: s.start * factor,
    end: s.end * factor,
    plannedStart: s.start,
    plannedEnd: s.end,
  }));
}
