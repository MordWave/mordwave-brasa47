// AuditService.record() is deliberately fire-and-forget (best-effort — see
// AuditInterceptor/AuditService): the HTTP response is never held up
// waiting for the audit row to land, so a test that just-created a resource
// and immediately reads audit_logs directly has a genuine, if usually tiny,
// race against that background write. Polling for it (rather than a single
// immediate read, or a synchronous await added to production code purely
// for testability) is the correct way to test an intentionally-async
// side effect.
export async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs = 2000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
