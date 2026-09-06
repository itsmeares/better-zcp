/**
 * `adduser "<username>" "<password>"` is the RCON command PZ's own
 * whitelist-add flow sends (a real player join password, chosen by an
 * operator or the player themselves) -- and until this fix, database/init.js's
 * logCommand() persisted that string VERBATIM into command_history, and
 * GET /history returned it to any rcon.execute holder unredacted. Unlike
 * apps/panel-server/utils/serverRconSecrets.js's rconPassword (the PANEL's own
 * reconnection credential, deliberately relocated to a side-file so it can
 * be read back), a player's whitelist password embedded in a logged
 * command has no legitimate reason to ever be recovered from the audit
 * trail -- command_history exists to show WHAT was run, not to double as a
 * password store. So this redacts in place and discards the secret
 * entirely, at WRITE time: a read-time filter would leave the cleartext
 * sitting in db.json for anyone with file access, and db.json has already
 * been the subject of one credential-extraction finding.
 *
 * ENUMERATED before writing this (2026-08-27): every command in
 * apps/panel-server/utils/commands.js's PZ_COMMANDS -- the panel's own structured
 * mirror of PZ's full admin command set -- for a parameter that can hold a
 * credential. Exactly ONE: adduser's optional `password` (commands.js's
 * own adduser entry). No other command (banuser, setaccesslevel, teleport,
 * changeoption, ...) has a password/token/secret-shaped parameter.
 * changeoption's generic `newValue` string was considered and rejected as
 * a live risk: PZ's changeoption targets server config options (weather,
 * limits, messages), not credentials, and no seeded/real usage sets a
 * secret through it.
 *
 * Matches on the STRING SHAPE the command actually takes once built
 * (`adduser "user" "pass"`, both args double-quoted -- verified against
 * RconService.addUser, apps/panel-server/services/rcon.js:1349 and :1602, its two
 * call sites), not on which UI path produced it, so this also covers a
 * password typed directly into the /execute console, not just the
 * whitelist-add flow. sanitizeQuotedArg() (rcon.js) throws on any `"` or
 * `\` in either argument before the command string is even built, so
 * there is no embedded-quote/escaping case this regex needs to handle.
 * Case-insensitive on the command name: PZ's RCON accepts adduser
 * regardless of case, and an operator typing into /execute isn't
 * constrained to the panel's own lowercase convention.
 */

const ADDUSER_WITH_PASSWORD = /(\badduser\s+"[^"]*")\s+"[^"]*"/gi;

export function redactRconCommandSecrets(text) {
  if (typeof text !== "string") return text;
  return text.replace(ADDUSER_WITH_PASSWORD, '$1 "[REDACTED]"');
}
