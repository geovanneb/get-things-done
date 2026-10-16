import type { PixelSprite } from './types';

// The folded page is shared; each band below is a hand-lettered 11x5 bitmap.
// A one-pixel outline and a right-hand gutter keep the lettering off the bezel.
function badge(band: string, letters: string[]): PixelSprite {
  return {
    w: 16,
    h: 16,
    rows: [
      '..000000000.....',
      '..0WWWWWWW00....',
      '..0WWWWWWW0w0...',
      '..0WWWWWWW0ww0..',
      '..0WWWWWWW0000..',
      '..0WWWWWWWWWw0..',
      '..0WWWWWWWWWw0..',
      '..0WWWWWWWWWw0..',
      '.00000000000000.',
      ...letters.map(row => `.0${row.replace(/#/g, 'W').replace(/\./g, band)}${band}0.`),
      '..0wwwwwwwwww0..',
      '..000000000000..',
    ],
  };
}

export const ICON_PDF: PixelSprite = badge('R', [
  '##..##..###',
  '#.#.#.#.#..',
  '##..#.#.##.',
  '#...#.#.#..',
  '#...##..#..',
]);

export const ICON_DOCX: PixelSprite = badge('E', [
  '##...#...##',
  '#.#.#.#.#..',
  '#.#.#.#.#..',
  '#.#.#.#.#..',
  '##...#...##',
]);

export const ICON_PPTX: PixelSprite = badge('O', [
  '##..##..###',
  '#.#.#.#..#.',
  '##..##...#.',
  '#...#....#.',
  '#...#....#.',
]);

export const ICON_XLSX: PixelSprite = badge('L', [
  '#.#.#....##',
  '#.#.#...#..',
  '.#..#....#.',
  '#.#.#.....#',
  '#.#.###.##.',
]);

export const ICON_MD: PixelSprite = badge('V', [
  '#...#.###..',
  '##.##.#..#.',
  '#.#.#.#...#',
  '#...#.#..#.',
  '#...#.###..',
]);

export const ICON_HTML: PixelSprite = badge('C', [
  '#.#.###.#.#',
  '#.#..#..###',
  '###..#..###',
  '#.#..#..#.#',
  '#.#..#..#.#',
]);

export const ICON_TXT: PixelSprite = badge('3', [
  '###.#.#.###',
  '.#..#.#..#.',
  '.#...#...#.',
  '.#..#.#..#.',
  '.#..#.#..#.',
]);

export const ICON_GENERIC: PixelSprite = {
  w: 16,
  h: 16,
  rows: [
    '..000000000.....',
    '..0WWWWWWW00....',
    '..0WWWWWWW0w0...',
    '..0WWWWWWW0ww0..',
    '..0WWWWWWW0000..',
    '..0WWWWWWWWWw0..',
    '..0W3333333Ww0..',
    '..0WWWWWWWWWw0..',
    '..0W33333333w0..',
    '..0WWWWWWWWWw0..',
    '..0W3333333Ww0..',
    '..0WWWWWWWWWw0..',
    '..0W33333WWWw0..',
    '..0WWWWWWWWWw0..',
    '..0wwwwwwwwww0..',
    '..000000000000..',
  ],
};

export const SCREEN_OFF: PixelSprite = {
  w: 16, h: 12,
  rows: [
    'gggggggggggggggg',
    '2222222222222222',
    'gggggggggggggggg',
    '2222222222222222',
    'gggggggggggggggg',
    '2222222222222222',
    'gggggggggggggggg',
    '2222222222222222',
    'gggggggggggggggg',
    '2222222222222222',
    'gggggggggggggggg',
    '2222222222222222',
  ],
};

// The renderer can blink this single cursor state at its idle cadence.
export const SCREEN_IDLE: PixelSprite = {
  w: 16, h: 12,
  rows: [
    'gggggggggggggggg',
    'gGGGgggggggggggg',
    'gGGGgggggggggggg',
    'gGGGgggggggggggg',
    'gGGGgggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ],
};

// Cyan travels clockwise around the globe; its lower-right handle stays lit.
export const SCREEN_SEARCH: PixelSprite[] = [
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gggggCCCgggggggg',
    'gggGGgGgGGgggggg',
    'ggGggGgGggGggggg',
    'ggGggGgGggGggggg',
    'ggGGGGGGGGGggggg',
    'ggGggGgGggGggggg',
    'gggGGgGgGGgggggg',
    'gggggGGGggCCgggg',
    'gggggggggggCCggg',
    'ggggggggggggCggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gggggGGGgggggggg',
    'gggGGgGgGCgggggg',
    'ggGggGgGggCggggg',
    'ggGggGgGggCggggg',
    'ggGGGGGGGGCggggg',
    'ggGggGgGggGggggg',
    'gggGGgGgGGgggggg',
    'gggggGGGggCCgggg',
    'gggggggggggCCggg',
    'ggggggggggggCggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gggggGGGgggggggg',
    'gggGGgGgGGgggggg',
    'ggGggGgGggGggggg',
    'ggGggGgGggGggggg',
    'ggGGGGGGGGGggggg',
    'ggGggGgGggGggggg',
    'gggGCgGgCGgggggg',
    'gggggCCCggCCgggg',
    'gggggggggggCCggg',
    'ggggggggggggCggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gggggGGGgggggggg',
    'gggCGgGgGGgggggg',
    'ggCggGgGggGggggg',
    'ggCggGgGggGggggg',
    'ggCGGGGGGGGggggg',
    'ggGggGgGggGggggg',
    'gggGGgGgGGgggggg',
    'gggggGGGggCCgggg',
    'gggggggggggCCggg',
    'ggggggggggggCggg',
    'gggggggggggggggg',
  ] },
];

export const SCREEN_WRITE: PixelSprite[] = [
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGgGGgGGGGgggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGgGGgGGGGgggg',
    'gggggggggggggggg',
    'gGGgGGGGgGGGGGgg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGgGGgGGGGgggg',
    'gggggggggggggggg',
    'gGGgGGGGgGGGGGgg',
    'gggggggggggggggg',
    'gGGGGgGGGgGGgggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGgGGgGGGGgggg',
    'gggggggggggggggg',
    'gGGgGGGGgGGGGGgg',
    'gggggggggggggggg',
    'gGGGGgGGGgGGgggg',
    'gggggggggggggggg',
    'gGGgGGGGGggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
];

export const SCREEN_READ: PixelSprite[] = [
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGGGgggGGGGGgg',
    'gggggggggggggggg',
    'gGGGGggggGGGGGgg',
    'gggggggggggggggg',
    'gGGGGGgggGGGgggg',
    'gggggggggggggggg',
    'gGGGgggggGGGgCgg',
    'gggggggggggggCgg',
    'gGGGGGgggggggCgg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
  { w: 16, h: 12, rows: [
    'gggggggggggggggg',
    'gGGGGGgggGGGGGgg',
    'gggggggggggggggg',
    'gGGGGggggGGGGGgg',
    'gggggggggggggggg',
    'gGGGGGgggGGGgggg',
    'gggggggggggggggg',
    'gGGGgggggGGGgggg',
    'gggggggggggggggg',
    'gGGGGGgggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ] },
];

export const FORMAT_ICONS: Record<string, PixelSprite> = {
  pdf: ICON_PDF, docx: ICON_DOCX, doc: ICON_DOCX, pptx: ICON_PPTX,
  ppt: ICON_PPTX, xlsx: ICON_XLSX, xls: ICON_XLSX, md: ICON_MD,
  markdown: ICON_MD, html: ICON_HTML, htm: ICON_HTML, txt: ICON_TXT,
};

/** Accept a bare extension or a leading dot, ignoring case and outer spaces. */
export function iconForFormat(format?: string): PixelSprite {
  const key = (format ?? '').trim().toLowerCase().replace(/^\./, '');
  return Object.prototype.hasOwnProperty.call(FORMAT_ICONS, key)
    ? FORMAT_ICONS[key]
    : ICON_GENERIC;
}
