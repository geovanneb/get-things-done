import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampOffset, coverScale, initialCrop, sourceRect, zoomTo } from './iconCrop';

const VIEW = 200;

test('a new picture starts centered and just covers the square', () => {
  const crop = initialCrop(800, 400, VIEW);
  assert.equal(crop.scale, coverScale(800, 400, VIEW));
  assert.equal(crop.scale, 0.5);
  assert.deepEqual(crop, { scale: 0.5, x: -100, y: 0 });
  assert.deepEqual(sourceRect(crop, VIEW), { sx: 200, sy: 0, size: 400 });
});

test('dragging stops at the edges, so the crop never shows empty space', () => {
  const at = (x: number, y: number) => clampOffset({ scale: 0.5, x, y }, 800, 400, VIEW);
  assert.deepEqual(at(50, 50), { scale: 0.5, x: 0, y: 0 });
  assert.deepEqual(at(-500, -500), { scale: 0.5, x: -200, y: 0 });
});

test('zooming keeps the center of the square on the same spot of the picture', () => {
  const start = initialCrop(800, 400, VIEW);
  const zoomed = zoomTo(start, 2, 800, 400, VIEW);
  assert.equal(zoomed.scale, 1);
  const before = sourceRect(start, VIEW);
  const after = sourceRect(zoomed, VIEW);
  assert.equal(before.sx + before.size / 2, after.sx + after.size / 2);
  assert.equal(before.sy + before.size / 2, after.sy + after.size / 2);
  assert.equal(after.size, 200);
});

test('zoom stays between cover and the maximum', () => {
  const start = initialCrop(400, 400, VIEW);
  assert.equal(zoomTo(start, 0.2, 400, 400, VIEW).scale, 0.5);
  assert.equal(zoomTo(start, 99, 400, 400, VIEW).scale, 2);
});
