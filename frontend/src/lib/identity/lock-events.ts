// Dependency-free so storage can subscribe while identity.ts is initializing.
const observers = new Set<() => void>();

export function onIdentityLock(observer: () => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function notifyIdentityLock(): void {
  for (const observer of [...observers]) {
    try { observer(); } catch { /* Other owners must still revoke their keys. */ }
  }
}
