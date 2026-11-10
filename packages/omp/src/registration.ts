const registrationKey = Symbol.for("session-navigation.omp.active");
const owner = globalThis as typeof globalThis & { [registrationKey]?: boolean };

export function acquireExtension(): boolean {
  if (owner[registrationKey]) return false;
  owner[registrationKey] = true;
  return true;
}

export function releaseExtension(): void {
  delete owner[registrationKey];
}
