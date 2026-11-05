/** Per-request scope for the video projection middleware. */
import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();

/** The request scope currently bound to the executing model stream, if any. */
export function currentScope() {
  return requests.getStore();
}

/** Bind every iterator operation to the request scope. */
export function scopedStream(scope, next) {
  return {
    [Symbol.asyncIterator]() {
      let iterator;
      const invoke = (method, value) => requests.run(scope, () => {
        iterator ??= next()[Symbol.asyncIterator]();
        if (!iterator[method]) {
          if (method === 'throw') return Promise.reject(value);
          return Promise.resolve({ done: true, value });
        }
        return iterator[method](value);
      });
      return {
        next: (value) => invoke('next', value),
        return: (value) => invoke('return', value),
        throw: (value) => invoke('throw', value),
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

/** Wrap a nested text-only call so it cannot inherit the outer video plan. */
export function isolatedStream(next) {
  return scopedStream(undefined, next);
}
