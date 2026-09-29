// Monospace glyphs are 0.6em wide, so at 12px each character takes 7.2px. textLength pins the
// text to that width, which keeps the layout identical whichever monospace font is installed.
const CHAR_WIDTH = 7.2;
const PADDING = 8;
const HEIGHT = 24;

const LABEL_BG = '#2a313f';
const VERIFIED_BG = '#1f7a45';
const UNVERIFIED_BG = '#6b2d3a';

// One decimal place, so float noise such as 111.19999999999999 never reaches the SVG.
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function badgeMessage(range: string): string {
  return range ? `RN ${range}` : 'no verified versions';
}

/** Builds the README badge: "rn.green" then the verified React Native range. */
export function badgeSvg(range: string): string {
  const label = 'rn.green';
  const message = badgeMessage(range);
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
<rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT}" fill="${range ? VERIFIED_BG : UNVERIFIED_BG}"/>
</g>
<g fill="#ffffff" font-family="'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12">
<text x="${PADDING}" y="16" textLength="${labelText}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>
<text x="${round(labelWidth + PADDING)}" y="16" textLength="${messageText}" lengthAdjust="spacingAndGlyphs">${escapeXml(message)}</text>
</g>
</svg>
`;
}
