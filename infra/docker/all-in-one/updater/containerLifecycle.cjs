function isMissingContainerError(error) {
  return /No such (?:container|object)/i.test(error?.message || "");
}

async function recreatePanelContainer(panelContainer, composeArgs, runCommand) {
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

module.exports = { recreatePanelContainer };