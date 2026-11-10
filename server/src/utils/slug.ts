import { createHash } from 'crypto';

// Folder names and ids (CTX-<slug>, OUT-<slug>) stay ASCII, as the schemas require. A title written in another
// script, such as Japanese, would lose every letter: it would give no slug at all, or only its digits, which an
// unrelated title can share. Such a title gets "<fallback>-<digits>-<hash of the title>": readable, ASCII, and the
// same title always gives the same slug, so the usual "already exists" check still applies.
export function titleSlug(title: string, fallback: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  if (slug && (/[a-z]/.test(slug) || /^\p{ASCII}*$/u.test(title))) return slug;
  const hash = createHash('sha256').update(title.normalize('NFC').trim()).digest('hex').slice(0, 8);
  return [fallback, slug.slice(0, 40), hash].filter(Boolean).join('-');
}
