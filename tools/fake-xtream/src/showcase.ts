// Showcase mode (SHOWCASE=1): invented channel, programme and title names with generated artwork, for website and
// store screenshots. Every name here is made up and every image is drawn from code (CLAUDE.md rules 1, 3 and 4):
// no real channels, broadcasters, leagues, films or series.

/** Invented channel names, by position; channels past the list keep their `Channel 123` names. */
export const SHOWCASE_CHANNELS = [
  'Northbridge News', 'Harbour One', 'Little Lantern', 'Studio Nine', 'Meridian 24', 'Atlas Docs', 'Pebble Kids',
  'Cobalt Music', 'Lakeside Local', 'Fieldnotes', 'Moonbeam', 'Echo Live', 'Westvale Weather', 'Glasshouse', 'Kite',
  'Low Tide Radio', 'Civic Hall', 'Wildwood', 'Paper Plane', 'Bandstand', 'Morning Desk', 'Open Road', 'Tiny Planet',
  'Night Shift',
] as const;

/** Programme names per live group (`GROUPS` order: News, Movies, Kids, Music). */
const PROGRAMMES: readonly (readonly string[])[] = [
  ['Evening Bulletin', 'The World Tonight', 'Business Hour', 'Local Report', 'Weather Watch', 'Late Edition', 'Morning Briefing', 'Market Close'],
  ['The Quiet Harbour', 'North of Midnight', 'Glass Orchard', 'The Long Summer', 'Paper Moons', 'Saltwater Road', 'Lights of Avalon Street', 'The Cartographer'],
  ['Paper Boats', 'Moon Garden', 'The Busy Burrow', 'Pip and the Kite', 'Sock Puppet Science', 'Tiny Builders', 'Bedtime Stories', 'Rainy Day Club'],
  ['Studio Sessions', 'Live at the Hall', 'Vinyl Hour', 'Late Night Jazz', 'The Chart Show', 'Acoustic Corner', 'Orchestra Nights', 'Open Mic'],
];

/** One line of guide text per group. */
const PROGRAMME_DESC = [
  'The day\'s main stories, with analysis and the weather.',
  'An evening film from the channel\'s own library.',
  'Gentle stories and songs for younger viewers.',
  'Performances recorded in front of a small audience.',
];

export const showcaseProgramme = (group: number, slot: number, channel: number) => {
  const list = PROGRAMMES[group % PROGRAMMES.length]!;
  return { title: list[(slot + channel * 3 + Math.floor((channel - 1) / 4)) % list.length]!, desc: PROGRAMME_DESC[group % PROGRAMME_DESC.length]! };
};

/** Invented film titles with a one-line plot; titles past the list fall back to numbered names. */
export const SHOWCASE_MOVIES: readonly (readonly [string, string])[] = [
  ['The Quiet Harbour', 'A lighthouse keeper finds a letter that was never sent.'],
  ['North of Midnight', 'Two strangers share the last train out of a snowed-in city.'],
  ['Glass Orchard', 'A family returns to the farm they swore they would sell.'],
  ['Paper Moons', 'A stage magician tries one final trick for an audience of one.'],
  ['Saltwater Road', 'Three sisters drive the coast to scatter their father\'s ashes.'],
  ['The Cartographer', 'A mapmaker is hired to chart an island that keeps moving.'],
  ['Lights of Avalon Street', 'A neighbourhood bands together to save its corner cinema.'],
  ['The Long Summer', 'Ten kids, one bicycle and the last holidays before everything changes.'],
  ['Copper Sky', 'A test pilot grounded for good finds a new way to fly.'],
  ['Small Hours', 'A night-shift nurse and a radio host keep each other awake.'],
  ['Winter Garden', 'An old botanist teaches her grandson to grow things in the cold.'],
  ['Undertow', 'A swimmer trains for the crossing that took her brother.'],
  ['The Last Ferry', 'An island town counts down to the day its ferry stops running.'],
  ['Hollow Pines', 'A ranger follows strange lights deep into the forest.'],
  ['Brass and Feathers', 'A marching band from a tiny village enters the national contest.'],
  ['Tidewater', 'Two rival fishing families are forced to share one boat.'],
  ['The Clockmaker\'s Daughter', 'She inherits a shop full of clocks that all stopped at the same time.'],
  ['Open Water', 'A sailing school takes its least likely student to sea.'],
  ['Kites Over Kestrel Bay', 'A boy builds a kite big enough to carry a message home.'],
  ['Night Market', 'A cook runs the busiest food stall in the city for one night only.'],
  ['Silver Linings Club', 'Retirees start a band and book a tour they cannot afford.'],
  ['The Map Room', 'A librarian discovers a door that is on no floor plan.'],
  ['Pale Blue Morning', 'An astronaut comes home to a town that has moved on.'],
  ['Field of Echoes', 'A sound engineer records a meadow that answers back.'],
  ['Second Spring', 'A widower takes over his wife\'s allotment and her rivals.'],
  ['Long Way Round', 'A courier with a broken van has one day to cross the country.'],
  ['Stone Circle', 'Students on a dig uncover something that should not be there.'],
  ['The Gilded Hour', 'A hotel doorman sees everything on the night of the grand reopening.'],
  ['Wavelength', 'A late-night caller tells a radio host about tomorrow\'s news.'],
  ['Riverlight', 'A ferryman\'s daughter learns the river has its own rules.'],
  ['Arcadia Lane', 'Neighbours compete in the most serious garden show in town.'],
  ['Lanterns', 'A festival maker loses her lanterns the week before the parade.'],
];

/** Invented series names. */
export const SHOWCASE_SERIES = [
  'Saltmarsh', 'The Lantern Office', 'Northern Lights Bakery', 'Harbour Watch', 'The Understudies', 'Wild Acres',
  'Signal & Noise', 'The Night Desk', 'Kestrel Bay', 'Little Inventors', 'Chalk & Cheese', 'The Orchard House',
] as const;

const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');

/** Splits a title into lines of at most `max` characters for the poster's title block. */
function lines(title: string, max: number): string[] {
  const out: string[] = [];
  for (const word of title.split(' ')) {
    const last = out[out.length - 1];
    if (last !== undefined && (last + ' ' + word).length <= max) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  return out;
}

/**
 * A generated 2:3 poster (or 16:9 backdrop when `wide`): a two-tone gradient, a horizon with a sun or moon and soft
 * hills, and the title set in large type. Drawn from the title's hash, so each title keeps its look.
 */
export function showcasePosterSvg(title: string, wide = false): string {
  const h = hash(title);
  const hue = h % 360;
  const hue2 = (hue + 30 + (h >> 9) % 60) % 360;
  const w = wide ? 1280 : 600;
  const ht = wide ? 720 : 900;
  const horizon = Math.round(ht * (wide ? 0.62 : 0.58));
  const sunX = Math.round(w * (0.25 + ((h >> 4) % 50) / 100));
  const sunR = Math.round(w * (wide ? 0.07 : 0.12));
  const sunY = horizon - Math.round(sunR * (0.4 + ((h >> 6) % 8) / 10));
  const hill = (y: number, amp: number, phase: number) => {
    const pts: string[] = [];
    for (let x = 0; x <= w; x += w / 8) pts.push(`${x.toFixed(0)},${(y + Math.sin(x / w * 6.28 + phase) * amp).toFixed(0)}`);
    return `M0,${ht} L${pts.join(' L')} L${w},${ht} Z`;
  };
  const titleLines = wide ? [] : lines(title.toUpperCase(), 12);
  const size = titleLines.some((l) => l.length > 9) ? 54 : 66;
  const text = titleLines.map((l, i) =>
    `<text x="44" y="${ht - 70 - (titleLines.length - 1 - i) * (size + 6)}" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="700" letter-spacing="2" fill="#fff">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">`
    + `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue2} 55% 16%)"/><stop offset="1" stop-color="hsl(${hue} 70% 52%)"/></linearGradient>`
    + `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="#000" stop-opacity="0"/>`
    + `<stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient></defs>`
    + `<rect width="${w}" height="${ht}" fill="url(#sky)"/>`
    + `<circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="hsl(${(hue + 40) % 360} 95% 82%)" opacity="0.92"/>`
    + `<path d="${hill(horizon, ht * 0.03, h % 7)}" fill="hsl(${hue2} 45% 22%)"/>`
    + `<path d="${hill(horizon + ht * 0.08, ht * 0.04, (h >> 3) % 7)}" fill="hsl(${hue2} 50% 13%)"/>`
    + `<rect width="${w}" height="${ht}" fill="url(#shade)"/>${text}</svg>`;
}

/** A square channel logo: a rounded tile with the channel's initials. */
export function showcaseLogoSvg(name: string): string {
  const h = hash(name);
  const initials = name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">`
    + `<rect width="200" height="200" rx="36" fill="hsl(${h % 360} 60% 45%)"/>`
    + `<text x="100" y="128" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="80" font-weight="700" fill="#fff">${esc(initials)}</text></svg>`;
}
