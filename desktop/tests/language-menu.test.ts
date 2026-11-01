import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLanguageMenu } from '../src/language-menu';

const base = { current: 'en', options: [{ id: 'auto', label: 'Auto' }, { id: 'en', label: 'English' }, { id: 'ja', label: 'Japanese' }] };

test('the menu bar takes a suggested language only in the expected shape', () => {
  const offer = { id: '3f1c2b7e-0000-4000-8000-000000000000', language: 'ja', label: 'Japanese', mode: 'mismatch' };
  assert.deepEqual(parseLanguageMenu({ ...base, suggested: offer })?.suggested, offer);
  for (const bad of [
    { ...offer, id: 'has spaces' }, { ...offer, id: 'x'.repeat(65) }, { ...offer, language: 'JA' }, { ...offer, label: '' },
    { ...offer, label: 'x'.repeat(41) }, { ...offer, mode: 'other' }, 'Japanese', { ...offer, label: 'Japa\nnese' },
    { ...offer, language: 'auto' }, null, [offer], { ...offer, id: null },
  ]) {
    const menu = parseLanguageMenu({ ...base, suggested: bad });
    assert.ok(menu, 'the menu itself still shows');
    assert.equal(menu!.suggested, undefined, JSON.stringify(bad));
  }
  assert.equal(parseLanguageMenu(base)?.suggested, undefined);
});
