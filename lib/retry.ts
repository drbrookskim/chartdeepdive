// Retry an async operation once before giving up. External data sources fail
// transiently; a single retry absorbs most blips without masking real outages.

export async function retryOnce<T>(
  op: () => Promise<T>,
  delayMs = 300,
): Promise<T> {
  try {
    return await op();
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return op(); // second failure propagates to the caller
  }
}
