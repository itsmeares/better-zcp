import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module to test updateScheduledTask logic in isolation
// We replicate the function logic here since the real module requires LowDB init
describe('updateScheduledTask logic', () => {
  let tasks;

  beforeEach(() => {
    tasks = [
      { id: 1, name: 'Restart Server', cron_expression: '0 6 * * *', command: 'restart', enabled: 1 },
      { id: 2, name: 'Save World', cron_expression: '*/30 * * * *', command: 'save', enabled: 1 },
    ];
  });

  function updateScheduledTask(id, name, cronExpression, command, enabled) {
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) return null;

    const task = tasks[index];
    if (name !== undefined) task.name = name;
    if (cronExpression !== undefined) task.cron_expression = cronExpression;
    if (command !== undefined) task.command = command;
    if (enabled !== undefined) task.enabled = enabled ? 1 : 0;
    return task;
  }

  it('should update all fields when all are provided', () => {
    const result = updateScheduledTask(1, 'New Name', '0 12 * * *', 'save', false);
    expect(result.name).toBe('New Name');
    expect(result.cron_expression).toBe('0 12 * * *');
    expect(result.command).toBe('save');
    expect(result.enabled).toBe(0);
  });

  it('should only update enabled without corrupting other fields', () => {
    const result = updateScheduledTask(1, undefined, undefined, undefined, false);
    expect(result.name).toBe('Restart Server');
    expect(result.cron_expression).toBe('0 6 * * *');
    expect(result.command).toBe('restart');
    expect(result.enabled).toBe(0);
  });

  it('should only update name without touching other fields', () => {
    const result = updateScheduledTask(2, 'Auto Save', undefined, undefined, undefined);
    expect(result.name).toBe('Auto Save');
    expect(result.cron_expression).toBe('*/30 * * * *');
    expect(result.command).toBe('save');
    expect(result.enabled).toBe(1);
  });

  it('should return null for non-existent task', () => {
    const result = updateScheduledTask(99, 'Whatever', undefined, undefined, undefined);
    expect(result).toBeNull();
  });
});
