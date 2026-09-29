import { newestTestedLine, verifiedRange, type Package, type ReactNativeLine } from './compat';

// Monospace glyphs are 0.6em wide, so at 12px each character takes 7.2px. textLength pins the
// text to that width, which keeps the layout identical whichever monospace font is installed.
const CHAR_WIDTH = 7.2;
const PADDING = 8;
const HEIGHT = 24;

const LABEL_BG = '#2a313f';
const VERIFIED_BG = '#1f7a45';
const UNVERIFIED_BG = '#6b2d3a';
const UNTESTED_BG = '#535b66';

export interface Badge {
  tone: 'verified' | 'failing' | 'untested';
  message: string;
}

const TONE_BG: Record<Badge['tone'], string> = {
  verified: VERIFIED_BG,
  failing: UNVERIFIED_BG,
  untested: UNTESTED_BG,
};

// One decimal place, so float noise such as 111.19999999999999 never reaches the SVG.
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * What the badge says about a package: the newest line that has any result, and the React Native
 * range it works on. Red means every stable React Native version was tried and none works; while
 * some are still untested, "no verified versions yet" stays grey.
 */
export function badgeFor(pkg: Package, rnLines: ReactNativeLine[]): Badge {
  const line = newestTestedLine(pkg);
  if (!line) return { tone: 'untested', message: 'not tested yet' };

  const range = verifiedRange(pkg, rnLines);
  if (range) return { tone: 'verified', message: `${line.line}.x: RN ${range}` };

  const allStableTried = rnLines.filter((rn) => rn.channel === 'stable').every((rn) => line.results.has(rn.line));
  return allStableTried
    ? { tone: 'failing', message: `${line.line}.x: no verified versions` }
    : { tone: 'untested', message: `${line.line}.x: no verified versions yet` };
}

/** Builds the README badge: "rn.green" then what {@link badgeFor} says. */
export function badgeSvg({ tone, message }: Badge): string {
  const label = 'rn.green';
  const labelText = round(label.length * CHAR_WIDTH);
  const messageText = round(message.length * CHAR_WIDTH);
  const labelWidth = round(labelText + PADDING * 2);
  const messageWidth = round(messageText + PADDING * 2);
  const width = round(labelWidth + messageWidth);
  const title = escapeXml(`${label}: ${message}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${title}">
<title>${title}</title>
<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="4"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelWidth}" height="${HEIGHT}" fill="${LABEL_BG}"/>
<rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT}" fill="${TONE_BG[tone]}"/>
</g>
<g fill="#ffffff" font-family="'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12">
<text x="${PADDING}" y="16" textLength="${labelText}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>
<text x="${round(labelWidth + PADDING)}" y="16" textLength="${messageText}" lengthAdjust="spacingAndGlyphs">${escapeXml(message)}</text>
</g>
</svg>
`;
}
