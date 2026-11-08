import { AsyncLocalStorage } from "node:async_hooks";

interface RequestLifetime {
  readonly signal: AbortSignal;
  readonly work: Set<Promise<unknown>>;
}

const lifetime = new AsyncLocalStorage<RequestLifetime>();

export function requestLifetime(signal: AbortSignal): RequestLifetime {
  return { signal, work: new Set() };
}

export function withRequestLifetime<Result>(scope: RequestLifetime, operation: () => Result): Result {
  return lifetime.run(scope, operation);
}

export function requestSignal(): AbortSignal | undefined {
  return lifetime.getStore()?.signal;
}

export function trackRequestWork<Result>(operation: () => Promise<Result>): Promise<Result> {
  const scope = lifetime.getStore();
  if (scope === undefined) return operation();
  scope.signal.throwIfAborted();
  const pending = operation();
  scope.work.add(pending);
  const remove = () => { scope.work.delete(pending); };
  void pending.then(remove, remove);
  return pending;
}
