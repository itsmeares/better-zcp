// Archive tests isolate file validation/retention from game lifecycle, covered by serverMaintenance.test.ts.
export function archiveService(BackupService: any) {
  let service: any;
  const maintenance = {
    serverId: "undefined",
    state: async () => {
      if (!service.serverManager) throw new Error("No server manager is available");
      if (!service.serverManager.getServerProcessDetails) throw new Error("Process detection is unavailable");
      const result = await service.serverManager.getServerProcessDetails();
      if (!result || result.scanFailed) throw new Error("Process detection failed");
      return result;
    },
    run: async (options: any) => {
      if ((await maintenance.state()).running) throw new Error("Archive fixture must be stopped");
      return options.work(new AbortController().signal);
    },
  };
  service = new BackupService(maintenance);
  const create = service.createBackup.bind(service);
  service.createBackup = (options: any = {}) => {
    maintenance.serverId = String(service.serverManager?._serverId ?? options.activeServer?.id);
    return create(options);
  };
  return service;
}
