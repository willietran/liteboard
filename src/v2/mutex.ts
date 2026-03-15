/**
 * Creates a promise-chain mutex for serializing async operations.
 * Returns a `serialize` function that queues work and ensures
 * only one operation runs at a time.
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let lock: Promise<void> = Promise.resolve();

  return <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = lock;
    let resolve!: () => void;
    lock = new Promise<void>((r) => {
      resolve = r;
    });

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve();
      }
    });
  };
}
