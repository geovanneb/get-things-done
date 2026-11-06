import { Fragment, type ReactNode } from 'react';
import type { MessageKey, Translate } from '../../../server/src/i18n/messages';

const MARK = '\u0000';

/** Puts React nodes into one whole translated sentence, so translators keep control of word order. */
export function rich(t: Translate, key: MessageKey, nodes: Record<string, ReactNode>): ReactNode {
  // A plural needs its real number to choose a form; it is text, so it needs no slot.
  const slots = Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, name === 'count' && typeof node === 'number' ? node : `${MARK}${name}${MARK}`]));
  const parts = (t as (key: string, values: Record<string, string | number>) => string)(key, slots).split(MARK);
  return parts.map((part, index) => <Fragment key={index}>{index % 2 ? nodes[part] : part}</Fragment>);
}
