import { isPreference, type LanguagePreference } from '../i18n/locale';
import { readUserConfig, updateUserConfig } from './userConfig';

export function interfaceLanguage(): { language: LanguagePreference } {
  const value = readUserConfig().interface_language;
  return { language: isPreference(value) ? value : 'auto' };
}
export async function setInterfaceLanguage(value: unknown): Promise<{ language: LanguagePreference }> {
  if (!isPreference(value)) throw Object.assign(new Error('Choose a supported interface language or Automatic.'), { statusCode: 400 });
  await updateUserConfig(current => ({ ...current, interface_language: value }));
  return { language: value };
}
