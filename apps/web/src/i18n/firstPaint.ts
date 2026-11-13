/** How long the first paint waits for the saved language's lazy locale chunk
 * (#899). English is bundled, so this only matters for another saved language
 * on a slow or stalled connection; same bound as `ERROR_REPORTER_WAIT_MS`. */
export const I18N_FIRST_PAINT_WAIT_MS = 300;

/**
 * Resolves when the initial language is ready, and at the latest after
 * `I18N_FIRST_PAINT_WAIT_MS`: a locale chunk that hangs must not keep the
 * console blank. Never rejects (a failed load falls back to English). Past the
 * bound the console renders in English; i18next keeps loading and switches
 * the language when the chunk arrives (`languageChanged` re-renders the
 * components that use `useTranslation()`).
 */
export async function awaitI18nFirstPaint(
  ready: Promise<unknown>,
  waitMs: number = I18N_FIRST_PAINT_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([ready.catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}
