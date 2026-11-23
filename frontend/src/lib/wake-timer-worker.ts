/** See wake-timer.ts. */
self.onmessage = (e: MessageEvent<{ id: number; ms: number }>) => {
  const { id, ms } = e.data;
  setTimeout(() => self.postMessage(id), ms);
};
