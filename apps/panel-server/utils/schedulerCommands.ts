export function classifyScheduledCommand(command: unknown): string {
  const commandLower = String(command ?? "").toLowerCase();
  if (commandLower.trimStart().startsWith("bridge:")) return "unsupported";
  if (commandLower === "restart") return "restart";
  if (commandLower === "save") return "save";
  if (commandLower.startsWith("servermsg ")) return "servermsg";
  return "raw";
}

export function isSchedulableCommand(command: string): boolean {
  return classifyScheduledCommand(command) !== "unsupported";
}
