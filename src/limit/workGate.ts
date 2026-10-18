import { ClientAbortedError, HttpError } from "../errors.js";

type Flight<T> = {
  waiters: number;
  controller: AbortController;
  promise: Promise<T>;
};

export type GateOutcome<T> = {
  value: T;
  shared: boolean;
};

export class WorkGate {
  private active = 0;
  private readonly flights = new Map<string, Flight<unknown>>();

  constructor(private readonly maxInflight: number) {}

  async run<T>(key: string, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<GateOutcome<T>> {
    if (signal.aborted) throw new ClientAbortedError();

    const existing = this.flights.get(key) as Flight<T> | undefined;
    if (existing) {
      existing.waiters += 1;
      return this.finish(existing, signal, true);
    }
    if (this.active >= this.maxInflight) {
      throw new HttpError(429, "overloaded", "server is busy", {
        headers: { "Retry-After": "1" },
      });
    }

    this.active += 1;
    const controller = new AbortController();
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(task(controller.signal));
    } catch (error) {
      this.active -= 1;
      throw error;
    }
    const flight: Flight<T> = {
      waiters: 1,
      controller,
      promise: pending.finally(() => {
        this.flights.delete(key);
        this.active -= 1;
      }),
    };
    this.flights.set(key, flight);
    return this.finish(flight, signal, false);
  }

  private finish<T>(flight: Flight<T>, signal: AbortSignal, shared: boolean): Promise<GateOutcome<T>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let left = false;

      const leave = (fromAbort: boolean) => {
        if (left) return;
        left = true;
        flight.waiters -= 1;
        if (fromAbort && flight.waiters <= 0) flight.controller.abort();
      };
      const succeed = (value: T) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ value, shared });
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = () => {
        leave(true);
        fail(new ClientAbortedError());
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          leave(false);
          succeed(value);
        },
        (error: unknown) => {
          leave(false);
          fail(error);
        },
      );
    });
  }
}
