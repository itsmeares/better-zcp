function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingContainerError(error: unknown): boolean {
  return /No such (?:container|object)/i.test(errorMessage(error));
}

export async function recreatePanelContainer(
  panelContainer: string,
  composeArgs: string[],
  runCommand: (command: string, args: string[]) => Promise<unknown>,
): Promise<void> {
  try {
    await runCommand("docker", ["inspect", panelContainer]);
  } catch (error) {
    if (!isMissingContainerError(error)) throw error;
    await runCommand("docker", ["compose", ...composeArgs]);
    return;
  }

  await runCommand("docker", ["stop", "-t", "60", panelContainer]);
  await runCommand("docker", ["rm", panelContainer]);
  await runCommand("docker", ["compose", ...composeArgs]);
}
