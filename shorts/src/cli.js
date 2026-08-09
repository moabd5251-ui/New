#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from './config.js';
import { loadShotList, renderShortList, validateShotList } from './render.js';

function parseArgs(argv) {
  const opts = { input: null, music: null, out: null, skipStock: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--music') opts.music = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--no-stock') opts.skipStock = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else rest.push(arg);
  }
  opts.input = rest[0] || null;
  return opts;
}

function usage() {
  console.log(`
  make-short — build a vertical Short from a shot list

  Usage:
    npm run make -- <shot-list.json> [options]

  Options:
    --music <file>   background music bed, mixed low under the voiceover
    --out <file>     output path (default: out/<slug>/<slug>.mp4)
    --no-stock       skip footage lookup, render placeholder cards only
    --help

  The shot list JSON is what prompts/03-shot-list.md produces.
`);
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.input) {
    usage();
    process.exit(opts.input ? 0 : 1);
  }

  if (!fs.existsSync(opts.input)) {
    console.error(`Shot list not found: ${opts.input}`);
    process.exit(1);
  }

  let shotList;
  try {
    shotList = loadShotList(opts.input);
  } catch (err) {
    console.error(`Shot list is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const problems = validateShotList(shotList);
  if (problems.length) {
    console.error('Shot list is invalid:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`\n  ${shotList.title || 'Untitled'}`);
  console.log(`  ${shotList.segments.length} segments, planned ${shotList.segments.at(-1).end.toFixed(1)}s\n`);

  const result = await renderShortList(shotList, {
    outFile: opts.out,
    music: opts.music,
    skipStock: opts.skipStock,
    log: (line) => console.log(`  ${line}`),
    warn: (line) => console.warn(`  ! ${line}`),
  });

  const size = (fs.statSync(result.outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n  done — ${result.outFile}`);
  console.log(`  ${result.duration.toFixed(2)}s, ${size} MB, ${result.placeholders} placeholder segment(s)`);

  if (result.attributions.length) {
    console.log('\n  Credits (paste into the video description):');
    const lines = [...new Set(result.attributions.map((a) => `  ${a.author} (${a.provider})`))];
    for (const line of lines) console.log(line);
  }
  console.log(`\n  Upload it with:  npm run upload -- ${path.dirname(result.outFile)}\n`);
}

main().catch((err) => {
  console.error(`\n  failed: ${err.message}\n`);
  process.exit(1);
});
