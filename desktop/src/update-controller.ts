/** Keep update policy independent of Electron so shutdown ordering can be regression-tested. */
export function updatesEnabled(packaged: boolean, signedRelease: unknown, disabled: string | undefined): boolean {
  return packaged && signedRelease === true && disabled !== '1';
}

export function createUpdateInstaller(prepare: () => Promise<void>, install: () => void, report: (error: unknown) => void): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= Promise.resolve().then(prepare).then(install).catch((error) => {
      pending = undefined;
      report(error);
    });
    return pending;
  };
}

/** checkForUpdates resolves before its separate background download promise. Consume both failures. */
export async function checkForUpdate(check: () => Promise<{ downloadPromise?: Promise<unknown> | null } | null>, report: (error: unknown) => void): Promise<void> {
  try {
    const result = await check();
    await result?.downloadPromise;
  } catch (error) {
    report(error);
  }
}
