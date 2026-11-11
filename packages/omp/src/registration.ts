const registrationKey = Symbol.for("session-navigation.omp.active");
const owner = globalThis as typeof globalThis & { [registrationKey]?: Set<string> };

export function acquireExtension(session = "main"): boolean {
  const sessions = owner[registrationKey] ??= new Set();
  if (sessions.has(session)) return false;
  sessions.add(session);
  return true;
}

export function releaseExtension(session?: string): void {
  if (session === undefined) delete owner[registrationKey];
  else owner[registrationKey]?.delete(session);
}
