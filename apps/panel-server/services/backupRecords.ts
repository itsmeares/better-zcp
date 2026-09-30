import { randomUUID } from "node:crypto";
import { saveBackupRecord, readBackupRecords, deleteBackupRecord } from "../database/init.ts";

export interface BackupRecord {
  id: string;
  fileName: string;
  createdAt: string;
  size: number;
  serverId: string | number | null;
  serverName: string;
  snapshot: unknown;
}

interface BackupInput {
  name: string;
  created: string;
  size: number;
}

interface ServerInput {
  id?: string | number | null;
  serverName?: string | null;
}

interface AddBackupRecordInput {
  backup: BackupInput;
  server?: ServerInput | null;
  snapshot?: unknown;
}

export async function addBackupRecord({
  backup,
  server,
  snapshot,
}: AddBackupRecordInput): Promise<BackupRecord> {
  const record: BackupRecord = {
    id: randomUUID(),
    fileName: backup.name,
    createdAt: backup.created,
    size: backup.size,
    serverId: server?.id ?? null,
    serverName: server?.serverName || "server",
    snapshot: snapshot || null,
  };
  await saveBackupRecord(record);
  return record;
}

export async function listBackupRecords({
  serverId,
  limit,
}: {
  serverId?: string | number | null;
  limit?: number;
} = {}): Promise<BackupRecord[]> {
  let records = await readBackupRecords() as BackupRecord[];
  if (serverId != null) {
    records = records.filter(
      (record) => String(record.serverId) === String(serverId),
    );
  }
  records = [...records].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? records.slice(0, limit)
    : records;
}

export async function removeBackupRecord(fileName: string): Promise<void> {
  await deleteBackupRecord(fileName);
}
