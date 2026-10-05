/** Process-local FIFO scheduler: cap in-flight requests and pace their starts. */
export function createRequestScheduler({
  concurrency = 2,
  minIntervalMs = 1_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 2;
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : 1_000;
  const pending = [];
  let active = 0;
  let nextStartAt = 0;
  let timer = null;

  function requestCancelledError(signal) {
    return signal?.reason || new Error("Request cancelled");
  }

  function drain() {
    if (timer !== null || active >= limit || !pending.length) return;

    const delay = Math.max(0, nextStartAt - now());
    if (delay > 0) {
      timer = setTimer(() => {
        timer = null;
        drain();
      }, delay);
      return;
    }

    const job = pending.shift();
    active += 1;
    nextStartAt = now() + interval;

    let result;
    try {
      result = job.operation();
    } catch (error) {
      result = Promise.reject(error);
    }

    Promise.resolve(result)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        drain();
      });

    // A slow request no longer prevents the next paced request from starting,
    // provided there is a free slot. Every settlement releases its own slot.
    drain();
  }

  function schedule(operation, { signal } = {}) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Expected a request operation"));
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(requestCancelledError(signal));
        return;
      }

      const job = {
        operation: () => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) throw requestCancelledError(signal);
          return operation();
        },
        resolve,
        reject,
      };

      const abort = () => {
        const position = pending.indexOf(job);
        if (position < 0) return;

        pending.splice(position, 1);
        signal.removeEventListener("abort", abort);
        reject(requestCancelledError(signal));

        if (timer !== null && !pending.length) {
          clearTimer(timer);
          timer = null;
        }
        drain();
      };

      signal?.addEventListener("abort", abort, { once: true });
      pending.push(job);
      drain();
    });
  }

  // Honor a provider's shared cooldown without holding an in-flight slot.
  // This applies only within this process, not across app instances/API users.
  schedule.pauseFor = (milliseconds) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;

    nextStartAt = Math.max(nextStartAt, now() + milliseconds);
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    drain();
  };
  schedule.getStats = () => ({ active, pending: pending.length, concurrency: limit });
  return schedule;
}
