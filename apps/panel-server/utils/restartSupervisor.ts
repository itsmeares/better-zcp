interface SupervisorOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

export function isLinuxPanelSupervisor({
  platform = process.platform,
  env = process.env,
}: SupervisorOptions = {}): boolean {
  return (
    platform === "linux" &&
    env.PANEL_SUPERVISOR_V === "2" &&
    env.PANEL_PRESERVE_GAME_SERVERS === "1"
  );
}
