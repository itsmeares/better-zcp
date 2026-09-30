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
    ...(process.env.PANEL_INSTANCE_ID ? { instanceId: process.env.PANEL_INSTANCE_ID } : {}),
    version: metadata.panelVersion,
    ...metadata,
    timestamp: now.toISOString(),
  };
}
