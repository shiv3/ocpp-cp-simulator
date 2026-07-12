/**
 * util.ts -- tiny shared helpers with no other natural home, used by
 * main.ts and by spec drive() functions under specs/.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
