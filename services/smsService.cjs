// services/smsService.cjs
//
// Circuit breaker for the HTTPSMS gateway. When the gateway fails repeatedly it
// is pointless (and wasteful) to keep hammering it: every attempt rejects, the
// Android gateway phone keeps buzzing, and a provider/API ban risk grows. The
// breaker therefore trips OPEN after N consecutive failures, fails fast on all
// sends until a cooldown elapses, then allows one HALF_OPEN probe:
//
//   CLOSED    -> sends normally
//   OPEN      -> all sends fail fast until cooldownUntil passes
//   HALF_OPEN -> a single probed send is allowed; success -> CLOSED,
//                failure -> OPEN again with a fresh cooldown
//
// Only the POST/send path goes through the breaker. Delivery reconciliation
// (the GET /v1/messages poller) is deliberately left outside so queued SMS can
// still be settled and retried after a gateway outage.

const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: 5,      // consecutive failures before OPEN
  cooldownMs: 60 * 1000,    // how long an OPEN circuit refuses to send
};

class SmsCircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? CIRCUIT_BREAKER_DEFAULTS.failureThreshold;
    this.cooldownMs = options.cooldownMs ?? CIRCUIT_BREAKER_DEFAULTS.cooldownMs;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0; // epoch ms
    this.lastError = null;
  }

  // True when a send is allowed right now.
  canSend(now = Date.now()) {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN" && now >= this.cooldownUntil) {
      console.log(`[${new Date().toISOString()}] SMS circuit breaker HALF_OPEN - single probe send allowed`);
      this.state = "HALF_OPEN";
      return true;
    }
    return this.state === "HALF_OPEN";
  }

  onSuccess() {
    if (this.state !== "CLOSED") {
      console.log(`[${new Date().toISOString()}] SMS circuit breaker ${this.state} -> CLOSED after successful send`);
    }
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  onFailure(err) {
    this.consecutiveFailures += 1;
    this.lastError = err?.message || String(err);

    if (this.state === "HALF_OPEN") {
      console.log(
        `[${new Date().toISOString()}] SMS circuit breaker probe failed (${this.consecutiveFailures} consecutive) -> OPEN for ${this.cooldownMs}ms`
      );
      this.state = "OPEN";
      this.cooldownUntil = Date.now() + this.cooldownMs;
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold && this.state !== "OPEN") {
      console.log(
        `[${new Date().toISOString()}] SMS circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures (cooldown ${this.cooldownMs}ms)`
      );
      this.state = "OPEN";
      this.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      cooldownUntil: this.cooldownUntil || null,
      lastError: this.lastError,
    };
  }
}

const smsCircuitBreaker = new SmsCircuitBreaker();

// Runs an async send function through the breaker. Fails fast with a
// `circuitOpen` error while the circuit is OPEN instead of waiting on a dead
// gateway; records success/failure so the breaker state stays accurate.
async function sendSmsWithBreaker(sendFn, label = "HTTPSMS") {
  if (!smsCircuitBreaker.canSend()) {
    const err = new Error(
      `SMS circuit breaker OPEN - ${label} send skipped (${smsCircuitBreaker.consecutiveFailures} consecutive failures)`
    );
    err.circuitOpen = true;
    throw err;
  }
  try {
    const result = await sendFn();
    smsCircuitBreaker.onSuccess();
    return result;
  } catch (err) {
    smsCircuitBreaker.onFailure(err);
    throw err;
  }
}

module.exports = { smsCircuitBreaker, sendSmsWithBreaker, SmsCircuitBreaker };