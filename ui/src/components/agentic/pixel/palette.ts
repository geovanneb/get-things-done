import { PixelPalette } from './types';

/**
 * The shared 32-bit-era palette. Every sprite in the Agent Floor is authored
 * against these keys, so a colour change here repaints the whole room.
 *
 * Ramps are three steps (shadow / base / light) which is what gives the art its
 * late-16-bit, early-32-bit console feel rather than a flat NES look.
 */
export const BASE_PALETTE: PixelPalette = {
  '.': null,

  // Neutral ramp — outlines and generic structure.
  '0': '#12101c', // outline, darkest
  '1': '#2b2b44', // deep shadow
  '2': '#4c4a6b', // mid
  '3': '#8b88ab', // light
  '4': '#d9d7e8', // highlight

  // Skin
  K: '#e8b08a',
  k: '#b9764f',

  // Hair
  H: '#3b2b2b',
  h: '#241a1a',

  // Shirt (re-tinted per agent)
  S: '#4f7fd4',
  s: '#2f4f8f',

  // Trousers
  P: '#3a3a55',
  p: '#242438',

  // Paper
  W: '#f6f3e6',
  w: '#cbc5ae',

  // Screen glow
  G: '#7de3f4',
  g: '#12414f',

  // Wood (desks, shelves, floor)
  B: '#9c6b3f',
  b: '#66421f',

  // Metal
  M: '#9aa3b8',
  m: '#5b6478',

  // Foliage
  L: '#5fbb62',
  l: '#2f7a3f',

  // Accents
  R: '#e0555a', // red
  Y: '#f2c14e', // yellow
  C: '#57d4c4', // cyan
  O: '#e8853f', // orange
  V: '#9b6bd6', // violet
  E: '#4f7fd4', // blue
};

/**
 * Per-agent colour schemes. Each entry overrides the shirt and hair ramps so a
 * floor full of agents reads as distinct people at a glance.
 */
export interface AgentSkin {
  id: string;
  label: string;
  overrides: PixelPalette;
}

export const AGENT_SKINS: AgentSkin[] = [
  { id: 'azure',   label: 'Azure',   overrides: { S: '#4f7fd4', s: '#2f4f8f', H: '#3b2b2b', h: '#241a1a' } },
  { id: 'moss',    label: 'Moss',    overrides: { S: '#5fbb62', s: '#2f7a3f', H: '#6b4a2a', h: '#40291a' } },
  { id: 'amber',   label: 'Amber',   overrides: { S: '#e8853f', s: '#a4531f', H: '#2b2b3b', h: '#1a1a26' } },
  { id: 'plum',    label: 'Plum',    overrides: { S: '#9b6bd6', s: '#633f96', H: '#1f1f2b', h: '#141420' } },
  { id: 'teal',    label: 'Teal',    overrides: { S: '#57d4c4', s: '#2b8a80', H: '#5b3a1f', h: '#3a2412' } },
  { id: 'rose',    label: 'Rose',    overrides: { S: '#e0555a', s: '#993239', H: '#e0c060', h: '#a88a34' } },
  { id: 'slate',   label: 'Slate',   overrides: { S: '#8b88ab', s: '#4c4a6b', H: '#2b2b3b', h: '#1a1a26' } },
  { id: 'gold',    label: 'Gold',    overrides: { S: '#f2c14e', s: '#b4862a', H: '#3b2b2b', h: '#241a1a' } },
];

/** Deterministically pick a skin for an id, so an agent keeps its look. */
export function skinFor(id: string): AgentSkin {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AGENT_SKINS[hash % AGENT_SKINS.length];
}

/** Room colours used by the renderer for things drawn without a sprite. */
export const ROOM = {
  wallTop: '#2a2740',
  wallBottom: '#37324f',
  floorA: '#6b4d34',
  floorB: '#5e422c',
  floorLine: '#4a3322',
  shadow: 'rgba(10, 8, 20, 0.35)',
  glow: 'rgba(125, 227, 244, 0.14)',
  ink: '#d9d7e8',
  inkDim: '#8b88ab',
} as const;
