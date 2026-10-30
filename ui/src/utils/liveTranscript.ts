/**
 * The live transcript as the page holds it. Pieces arrive numbered, by page, and can arrive twice or out of order after
 * a reconnect; they are kept in order, once each, and only the latest ones, so an 8-hour meeting stays light. The
 * whole transcript is saved on the server all along.
 */
export interface LivePiece { i: number; start: number; end: number; text: string }

/** Pieces kept on the page: about two hours of talk. */
export const MAX_PIECES = 2000;

/** The pieces and where to read on from. A new generation is a new recording: it starts over. */
export interface LiveState { generation: string | null; pieces: LivePiece[]; next: number }

export const emptyLive: LiveState = { generation: null, pieces: [], next: 0 };

export function mergeLive(state: LiveState, generation: string | null, incoming: LivePiece[], next: number): LiveState {
  const base = state.generation === generation ? state : { ...emptyLive, generation };
  const known = new Set(base.pieces.map((p) => p.i));
  const fresh = incoming.filter((p) => !known.has(p.i));
  const pieces = fresh.length ? [...base.pieces, ...fresh].sort((a, b) => a.i - b.i).slice(-MAX_PIECES) : base.pieces;
  return { generation, pieces, next: Math.max(base.next, next) };
}

/** h:mm:ss or m:ss of a recording. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
