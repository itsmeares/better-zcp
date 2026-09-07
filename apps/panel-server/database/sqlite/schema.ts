import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const panelState = sqliteTable("panel_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const panelRecords = sqliteTable("panel_records", {
  key: text("key").primaryKey(),
  collection: text("collection").notNull(),
  position: integer("position").notNull(),
  value: text("value").notNull(),
});

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name"),
  serverName: text("server_name"),
  installPath: text("install_path"),
  serverPort: integer("server_port"),
  rconHost: text("rcon_host"),
  rconPort: integer("rcon_port"),
  isRemote: integer("is_remote"),
  isActive: integer("is_active"),
  lifecycleProvider: text("lifecycle_provider"),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  role: text("role"),
  roleId: text("role_id"),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name"),
  isSeeded: integer("is_seeded"),
  capabilities: text("capabilities").notNull(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  name: text("name"),
  cronExpression: text("cron_expression"),
  command: text("command"),
  serverId: text("server_id"),
  enabled: integer("enabled"),
  lastRun: text("last_run"),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
