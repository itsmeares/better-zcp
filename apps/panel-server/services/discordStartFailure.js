import { sanitizeError } from "../utils/sanitize.js";


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
