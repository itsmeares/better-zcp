// Per-install setup token: the shape Jupyter, Portainer, and similar tools
// converged on for "a fresh instance has no owner yet". Before any admin
// account exists, this panel has no password to gate first-run setup with —
// but on a remote/internet-facing deployment, "no password yet" must not
// mean "whoever reaches the port first wins the race to become admin".
//
// The token is generated once per install, persisted, and printed to the
// startup log only while it's actually needed. Whoever completes first-run
// setup (via POST /api/auth/setup, or an OIDC bootstrap callback)
// must present it. It is NOT a route guard: it gates the *condition* "no
// admin account exists yet", wherever that condition is reachable from, so
// a second bootstrap entry point (e.g. OIDC) is covered by calling
// verifySetupToken() from its own handler rather than needing its own,
// possibly-inconsistent mechanism.
//
// This module only generates/prints/verifies the token. It does not decide
// which routes are reachable pre-setup or wire itself into any handler —
// that lives in server/services/auth.js and server/routes/auth.js, which
// this fork does not own here.

import crypto from "crypto";
import { getSetting, setSetting } from "../database/init.js";
import { createLogger } from "./logger.js";

const log = createLogger("Setup");
const TOKEN_BYTES = 32; // 256 bits — always compared, never memorized, so length costs nothing.

/**
 * Returns the per-install setup token, generating and persisting one on
 * first use. An operator can pre-seed it via the SETUP_TOKEN env var
 * (useful for scripted/automated deployments, e.g. `docker run -e
 * SETUP_TOKEN=...`); if set, it always wins and nothing is written to the
 * database. Never regenerates an existing persisted token — restarting the
 * panel before setup completes must reprint the SAME value, not a new one,
 * or a missed log line becomes unrecoverable without editing the database
 * by hand.
 */
export async function getOrCreateSetupToken() {
  const envToken = process.env.SETUP_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  let token = await getSetting("setupToken");
  if (!token) {
    token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    await setSetting("setupToken", token);
    log.info("Generated a new per-install setup token");
  }
  return token;
}

/**
 * Prints the setup token to the log, but only while it's actually needed.
 * Call once at startup (see logExposureWarningIfNeeded in server/index.js,
 * which this is meant to run alongside) with the same `needsSetup` value
 * already computed there — this function does not re-derive it, so a
 * caller and its exposure-warning sibling can never disagree about whether
 * setup is pending.
 */
export async function logSetupTokenIfNeeded(needsSetup, loggerInstance = log) {
  if (!needsSetup) return;
  const token = await getOrCreateSetupToken();
  loggerInstance.warn(
    `SETUP TOKEN required to complete first-run setup: ${token}\n` +
      "    Treat this like a password: anyone who has it can create the admin account. " +
      "Restart the panel to print it again if you lose it, or set SETUP_TOKEN yourself " +
      "before starting to choose your own value.",
  );
}

/**
 * Constant-time verification against the persisted/env token. Returns
 * false (never throws) for a missing, empty, or wrong-length candidate —
 * the token's length is not secret (it is always the same fixed size, or
 * whatever length an operator chose via SETUP_TOKEN), only its value is,
 * so a length-based early return leaks nothing timingSafeEqual itself
 * would have protected.
 */
export async function verifySetupToken(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = await getOrCreateSetupToken();
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Clears the persisted token once it can no longer be used — call this
 * right after the first admin account is successfully created, from
 * whichever bootstrap path created it. Optional hygiene, not a security
 * requirement (the value is already unreachable once needsSetup() is
 * false, since callers are expected to check that first), but leaving a
 * stale token sitting in the database is a red herring for the next person
 * reading it.
 */
export async function clearSetupToken() {
  await setSetting("setupToken", null);
}
