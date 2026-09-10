import {
  getDiskStatusForPath,
  type DiskMonitor,
} from "../services/diskMonitor.ts";
import { getDataPaths } from "./paths.ts";

type DiskMonitorLike = Pick<DiskMonitor, "getDiskStatus">;

export async function buildDiskSpace(
  diskMonitor?: DiskMonitorLike | null,
) {
  const saveVolume = diskMonitor?.getDiskStatus() ?? null;
  const panelData = await getDiskStatusForPath(getDataPaths().dataDir);
  return { saveVolume, panelData };
}
