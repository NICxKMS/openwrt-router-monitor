const REQUEST_TIMEOUT_MS = 20000;
export async function withTimeout<T>(work: PromiseLike<T>, milliseconds = REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Could not confirm completion because the request took too long. Refresh to check the result before retrying.')), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export const boundedFetch: typeof fetch = async (input, init) => {
  const source = init?.signal || (input instanceof Request ? input.signal : undefined);
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = source ? AbortSignal.any([source, deadline]) : deadline;
  try { return await fetch(input, { ...init, signal }); }
  catch (error) {
    if (deadline.aborted && !source?.aborted) throw new Error('Could not confirm completion because the request took too long. Refresh to check the result before retrying.');
    throw error;
  }
};
export function actionError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error || 'The action could not be completed.');
  if (/abort|timeout|timed out/i.test(message)) return 'Could not confirm completion because the request took too long. Refresh to check the result before retrying.';
  if ((error instanceof DOMException && error.name==='NotAllowedError') || /clipboard|write permission/i.test(message)) return 'Copy was blocked by your browser. Select the text and copy it manually.';
  if (/row-level security|permission denied|not authorized/i.test(message)) return 'This account does not have permission for that action. Sign in again or ask the project administrator.';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'Could not confirm completion. Check your connection and refresh before trying again.';
  return message.replace(/\bnx[de]_[a-f0-9]{64}\b/gi, '[private credential]').replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[private session]').replace(/\bsb_secret_[a-zA-Z0-9_-]+\b/g, '[private key]').slice(0, 400);
}
export function assertResult<T extends {data:unknown;error:{message:string}|null}>(result:T):T['data'] {
  if(result.error)throw new Error(result.error.message);
  return result.data;
}
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select the text and copy it manually.');
  await navigator.clipboard.writeText(text);
}
