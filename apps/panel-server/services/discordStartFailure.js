import { sanitizeError } from "../utils/sanitize.js";

// Split out of discordBot.js on purpose: this has no dependency on the
// discord.js package (~4.2MB transformed cold, see routeRoleSweep.test.js's
// header comment for the timeout that cost caused once already), so any test
// that only needs the message-selection logic below -- not a real Discord
// client -- can import it without paying that cost or needing to mock it.

// Turns a start() failure's lastStartError.kind into the specific reason a
// user should see, instead of a static "check configuration" that fits
// every cause identically. Shared by routes/discord.js's POST /start (the
// one-time toast at the moment someone clicks Start) and getStatus() (the
// persistent record, since a user who navigates away and comes back should
// still see WHY, not just that it failed).
export function describeStartFailure(lastStartError) {
  const kind = lastStartError?.kind;
  if (kind === "NoToken") {
    return "No bot token is configured. Add one below and save.";
  }
  if (kind === "TokenInvalid") {
    return "Invalid token. Check the token below and save again.";
  }
  if (kind === "DisallowedIntents") {
    return "Discord rejected the connection: this bot needs the Server Members and Message Content privileged intents enabled. Open your application in the Discord Developer Portal -> Bot, turn both on, then try starting the bot again. This is not a token or ID problem.";
  }
  if (kind === "ReadyTimeout") {
    return "Discord didn't respond within 30 seconds. This usually means a network problem between the panel and Discord, not your configuration -- try again in a moment.";
  }
  if (lastStartError?.message) {
    return `Failed to start bot: ${sanitizeError(lastStartError.message)}`;
  }
  return "Failed to start bot - check configuration";
}
