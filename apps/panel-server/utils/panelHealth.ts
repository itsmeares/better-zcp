export type PanelHealthMetadata = {
  panelVersion: string;
  buildSha: string;
  apiContractVersion: number;
};

export function buildPanelHealthPayload(
  metadata: PanelHealthMetadata,
  now = new Date(),
) {
  return {
    status: "ok",
    version: metadata.panelVersion,
    ...metadata,
    timestamp: now.toISOString(),
  };
}
