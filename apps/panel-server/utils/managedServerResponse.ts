type ServerRecord = Record<string, any>;

export function withRemoteConfigState(
  server: ServerRecord,
  settings: ServerRecord,
): ServerRecord {
  return {
    ...server,
    remoteConfigConfigured: Boolean(
      server.isRemote &&
      settings.panelBridgeSftpHost &&
      settings.panelBridgeSftpConfigPath,
    ),
  };
}
