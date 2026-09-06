import { randomUUID } from "node:crypto";
import { getSetting, setSetting } from "../database/init.js";

const SETTINGS_KEY = "backupRecords";
const MAX_RECORDS = 500;
let mutationChain: Promise<void> = Promise.resolve();

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

function mutateRecords(mutator: (records: BackupRecord[]) => void): Promise<void> {
  const operation = mutationChain.then(async () => {
    const records = await readRecords();
    mutator(records);
    await saveRecords(records);
  });
  mutationChain = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readRecords(): Promise<BackupRecord[]> {
  const stored = (await getSetting(SETTINGS_KEY)) as unknown;
  return Array.isArray(stored) ? (stored as BackupRecord[]) : [];
}

async function saveRecords(records: BackupRecord[]): Promise<void> {
  await setSetting(SETTINGS_KEY, records.slice(0, MAX_RECORDS));
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
  await mutateRecords((records) => {
    records.unshift(record);
  });
  return record;
}

export async function listBackupRecords({
  serverId,
  limit,
}: {
  serverId?: string | number | null;
  limit?: number;
} = {}): Promise<BackupRecord[]> {
  let records = await readRecords();
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
  await mutateRecords((records) => {
    const retained = records.filter((record) => record.fileName !== fileName);
    records.splice(0, records.length, ...retained);
  });
}
