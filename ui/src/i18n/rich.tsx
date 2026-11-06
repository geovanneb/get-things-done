import { Fragment, type ReactNode } from 'react';
import type { MessageKey, Translate } from '../../../server/src/i18n/messages';

const MARK = '\u0000';

/** Puts React nodes into one whole translated sentence, so translators keep control of word order. */
export function rich(t: Translate, key: MessageKey, nodes: Record<string, ReactNode>): ReactNode {
  const slots = Object.fromEntries(Object.keys(nodes).map(name => [name, `${MARK}${name}${MARK}`]));
  const parts = (t as (key: string, values: Record<string, string>) => string)(key, slots).split(MARK);
  return parts.map((part, index) => <Fragment key={index}>{index % 2 ? nodes[part] : part}</Fragment>);
}
