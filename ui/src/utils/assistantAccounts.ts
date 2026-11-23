import { tr } from '@/i18n/current';
import { serverText } from '@/i18n/serverText';
import type { AssistantAccount, AssistantAccountsView, AssistantSignIn, AssistantSignInMethod } from '@/types';

/**
 * Settings → Assistant accounts (#505): what each account shows and allows, worked out here so the wording can be
 * tested without a page. Accounts are named by who is signed in, never by folder: paths stay under Details.
 */

/** "Pro plan" from the tool's plan id ("pro", "max", "business"); null when there is none. */
export function planText(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const name = plan.replace(/[_-]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return /\bplan\b/i.test(name) || /copilot/i.test(name) ? name : tr('assistantAccounts.plan', { plan: name });
}

/** Who is signed in, as people recognise it: the email, else the organization; null when not known. */
export function who(a: Pick<AssistantAccount, 'account'>): string | null {
  return a.account?.email ?? a.account?.organization ?? null;
}

/** The account's main line: "Signed in as name@example.com", "Not signed in" or why it is not known. */
export function accountLine(a: Pick<AssistantAccount, 'problem' | 'signed_in' | 'account' | 'name'>): string {
  if (a.problem) return serverText(a.problem);
  if (a.signed_in === null) return tr('assistantAccounts.couldNotCheck');
  if (!a.signed_in) return tr('assistantAccounts.notSignedIn');
  const person = who(a);
  return person ? tr('assistantAccounts.signedInAs', { who: person }) : tr('assistantAccounts.signedIn');
}

/** The smaller line under it: the name the user gave, and the plan. */
export function accountSubline(a: Pick<AssistantAccount, 'name' | 'account' | 'signed_in' | 'problem'>): string {
  return [a.name, a.signed_in && !a.problem ? planText(a.account?.plan) : null].filter(Boolean).join(' · ');
}

/** The list of accounts shows only when there is more than one: otherwise one line, as before. */
export function showChoice(view: Pick<AssistantAccountsView, 'accounts'>): boolean {
  return view.accounts.length > 1;
}

/** The methods offered on the main screen: Console (billed per use) only under Details, or when last used. */
export function offeredMethods(view: Pick<AssistantAccountsView, 'methods'>, a: Pick<AssistantAccount, 'last_method'> | null, details: boolean): AssistantSignInMethod[] {
  return view.methods.filter((m) => m !== 'console' || details || a?.last_method === 'console');
}

/** The method "Sign in" starts with: the one this account last used, else the assistant's default. */
export function defaultMethod(view: Pick<AssistantAccountsView, 'methods'>, a: Pick<AssistantAccount, 'last_method'> | null): AssistantSignInMethod | null {
  return a?.last_method && view.methods.includes(a.last_method) ? a.last_method : view.methods[0] ?? null;
}

/** What may be done with an account now. A sign-in going blocks every other sign-in and sign-out. */
export function accountActions(view: Pick<AssistantAccountsView, 'methods' | 'can_sign_out' | 'installed'>, a: AssistantAccount, signInGoing: boolean): { use: boolean; signIn: boolean; signOut: boolean; remove: boolean } {
  const usable = view.installed && !a.problem;
  return {
    use: !a.chosen && !a.problem,
    signIn: usable && !signInGoing && view.methods.length > 0,
    signOut: usable && !signInGoing && view.can_sign_out && a.signed_in === true,
    remove: a.kind === 'added' && !a.chosen,
  };
}

/** The line shown for a sign-in that ended, in plain words; null while it is going. */
export function signInResult(s: AssistantSignIn): { tone: 'success' | 'warning' | 'critical'; text: string } | null {
  if (s.status === 'running') return null;
  if (s.status === 'succeeded') return { tone: 'success', text: tr('assistantAccounts.signedInDone') };
  if (s.status === 'cancelled') return { tone: 'warning', text: tr('assistantAccounts.signInCancelled') };
  return { tone: 'critical', text: serverText(s.message) ?? tr('server.signInUnfinished') };
}
