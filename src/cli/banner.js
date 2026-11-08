// @ts-check
// The ontologizer mark in the terminal: a centre node with 8 coloured nodes around it (the product in
// miniature). On a TTY the centre appears, then the 8 nodes grow in clockwise from the top, each with
// its spoke, in the brand colours. Plain ASCII only, so every character is one column wide everywhere.

import { BRAND } from '../../web/shared/tokens.js';

export const TAGLINE = 'a live map of any topic';

// Brand node colours, clockwise from the top, and the spoke grey: the only source is tokens.js.
const BRAND_NODES = BRAND.nodes;

// The full mark, 9 rows x 17 columns. In GROUPS, each cell's digit names who owns it: 0-7 the
// clockwise nodes (and their spokes), C the centre, '.' empty.
const ART = [
  '        o        ',
  '   o    |    o   ',
  '     \\  |  /     ',
  '      \\ | /      ',
  'o-------@-------o',
  '      / | \\      ',
  '     /  |  \\     ',
  '   o    |    o   ',
  '        o        ',
];
const GROUPS = [
  '........0........',
  '...7....0....1...',
  '.....7..0..1.....',
  '......7.0.1......',
  '66666666C22222222',
  '......5.4.3......',
  '.....5..4..3.....',
  '...5....4....3...',
  '........4........',
];

// The compact mark, 3 rows x 5 columns.
const MINI = ['o o o', 'o-@-o', 'o o o'];
const MINI_GROUPS = ['7.0.1', '66C22', '5.4.3'];

/** The installed package version ('' if unreadable). */
export async function packageVersion() {
  try {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

/** The static frame, no colour: shared with the README. */
export const BANNER_ART = ART.join('\n');

const FULL_MIN = 64;
const COMPACT_MIN = 36;

/** @param {string} hex */
function fg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Colour one mark row, showing only the groups already "grown".
 * @param {string} row @param {string} groups @param {number} shown nodes shown (0..8); -1 = nothing
 * @param {boolean} color
 */
function paintRow(row, groups, shown, color) {
  let out = '';
  for (let i = 0; i < row.length; i++) {
    const g = groups[i];
    const visible = g === 'C' ? shown >= 0 : g !== '.' && Number(g) < shown;
    const ch = visible ? row[i] : ' ';
    if (!color || ch === ' ') out += ch;
    else if (g === 'C') out += `${BOLD}${ch}${RESET}`; // terminal background unknown: default fg, bold
    else if (ch === 'o') out += `${BOLD}${fg(BRAND_NODES[Number(g)])}${ch}${RESET}`;
    else out += `${fg(BRAND.spoke)}${ch}${RESET}`;
  }
  return out.replace(/ +$/, '');
}

/**
 * The banner lines for a terminal of `columns` width. `shown` is the animation step (8 = complete).
 * @param {{ columns?: number, color?: boolean, version?: string, shown?: number }} opts
 * @returns {string[]}
 */
export function renderBanner({ columns = 80, color = false, version = '', shown = 8 } = {}) {
  const name = color ? `${BOLD}ontologizer${RESET}` : 'ontologizer';
  const ver = version ? ` ${version}` : '';
  const tag = color ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  if (columns >= FULL_MIN) {
    return ART.map((row, r) => {
      const art = paintRow(row, GROUPS[r], shown, color);
      const pad = ' '.repeat(Math.max(0, 17 - visibleWidth(art)));
      if (r === 4) return `${art}${pad}   ${name}${ver}`;
      if (r === 5) return `${art}${pad}   ${tag}`;
      return art;
    });
  }
  if (columns >= COMPACT_MIN) {
    return MINI.map((row, r) => {
      const art = paintRow(row, MINI_GROUPS[r], shown, color);
      const pad = ' '.repeat(Math.max(0, 5 - visibleWidth(art)));
      if (r === 1) return `${art}${pad}  ${name}${ver}`;
      if (r === 2 && 5 + 2 + TAGLINE.length <= columns) return `${art}${pad}  ${tag}`;
      return art;
    });
  }
  // Narrow: just the name (and version when it fits); never wider than the terminal.
  const plain = `ontologizer${ver}`;
  return [plain.length <= columns ? plain : 'ontologizer'.slice(0, Math.max(0, columns))];
}

/** Display width: strip ANSI escapes; every remaining character is ASCII (one column). @param {string} s */
export function visibleWidth(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

/**
 * Colour and animation rules for a stream and an env.
 * @param {{ isTTY?: boolean }} stream @param {NodeJS.ProcessEnv} env
 */
export function bannerMode(stream, env) {
  const tty = stream.isTTY === true;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  const color = env.NO_COLOR === undefined && (tty || forced);
  const animate = tty && color && !env.CI && env.NO_COLOR === undefined && !env.ONTOLOGIZER_NO_ANIM;
  return { tty, color, animate };
}

/**
 * Print the banner on a TTY (animated when allowed). Prints nothing when stdout is not a TTY.
 * @param {{ stdout: { write(s: string): any, isTTY?: boolean, columns?: number }, env: NodeJS.ProcessEnv }} deps
 * @param {{ version?: string, stepMs?: number }} [opts]
 */
export async function showBanner(deps, { version = '', stepMs = 45 } = {}) {
  const out = deps.stdout;
  const { tty, color, animate } = bannerMode(out, deps.env);
  if (!tty) return;
  const columns = out.columns || 80;
  const final = renderBanner({ columns, color, version, shown: 8 });
  if (!animate || final.length === 1) {
    out.write(`${final.join('\n')}\n\n`);
    return;
  }
  const rows = final.length;
  out.write('\x1b[?25l'); // hide the cursor while drawing
  try {
    for (let shown = 0; shown <= 8; shown++) {
      const lines = renderBanner({ columns, color, version, shown });
      if (shown > 0) out.write(`\x1b[${rows}A`);
      out.write(lines.map((l) => `\r\x1b[2K${l}`).join('\n') + '\n');
      if (shown < 8) await new Promise((r) => setTimeout(r, shown === 0 ? stepMs * 2 : stepMs));
    }
    out.write('\n');
  } finally {
    out.write('\x1b[?25h');
  }
}
