/** Runs work for the same key in request order while allowing unrelated keys
 *  to proceed independently. A failed task does not poison the key's queue. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const tail = operation.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return operation;
  }
}
