import express from 'express';
import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:Scheduler');
import { sanitizeError, sanitizeErrorParams } from '../utils/sanitize.ts';
import { ErrorCode } from '../utils/errorCodes.ts';
import {
  getScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  getScheduleHistory,
  clearScheduleHistory,
  getActiveServer,
  getServer
} from '../database/init.js';
import { requirePermission } from '../services/permissions.js';
import { requiredCapabilityForScheduledCommand } from '../services/scheduler.js';
import {
  hasUnsupportedCronFieldCount,
  isCronTooFrequent,
  isValidIanaTimezone,
} from '../utils/cronValidation.ts';
import { parseBoundedInteger, parseClampedInteger } from '../utils/queryNumbers.ts';

export { hasUnsupportedCronFieldCount };

export function parseTaskId(value) {
  return parseBoundedInteger(value, null, 1, Number.MAX_SAFE_INTEGER);
}

export function emitActionResult(io, payload) {
  if (typeof io?.emit === 'function') io.emit('scheduler:action_result', payload);
}

const router = express.Router();

router.use(requirePermission('automation.manage'));

async function requireCapabilityInline(capability, req, res) {
  let passed = false;
  await requirePermission(capability)(req, res, () => {
    passed = true;
  });
  return passed;
}

router.get('/status', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const status = scheduler.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get scheduler status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put('/timezone', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';
    log.info(`PUT /timezone: ${timezone}`);

    if (!timezone) {
      return res.status(400).json({ error: 'A timezone is required', code: ErrorCode.SCHEDULER_TIMEZONE_REQUIRED });
    }

    if (!isValidIanaTimezone(timezone)) {
      return res.status(400).json({
        error: `"${timezone}" is not a valid timezone name (e.g. "America/New_York", "UTC")`,
        code: ErrorCode.SCHEDULER_INVALID_TIMEZONE,
        params: sanitizeErrorParams({ tz: timezone }),
      });
    }

    const status = await scheduler.setTimezone(timezone);
    res.json({ success: true, ...status });
  } catch (error) {
    log.error(`Failed to update scheduler timezone: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put('/restart-warning', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const restartWarning = await scheduler.setRestartWarning(req.body);
    res.json({ success: true, restartWarning });
  } catch (error) {
    log.error(`Failed to update restart warning: ${error.message}`);
    res.status(400).json({ error: sanitizeError(error.message) });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const tasks = await getScheduledTasks();
    res.json({ tasks });
  } catch (error) {
    log.error(`Failed to get scheduled tasks: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/validate-cron', async (req, res) => {
  try {
    const cronExpression = req.body?.cronExpression;
    if (!cronExpression) {
      return res.status(400).json({ valid: false, error: 'cronExpression is required', code: ErrorCode.SCHEDULER_CRON_EXPRESSION_REQUIRED });
    }

    const isValid = cron.validate(cronExpression);
    if (!isValid) {
      return res.json({ valid: false, error: 'Invalid cron expression format', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.json({
        valid: false,
        error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday.',
        code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED,
      });
    }

    if (isCronTooFrequent(cronExpression)) {
      return res.json({
        valid: false,
        error: 'Tasks cannot run more frequently than every 5 minutes',
        code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT,
      });
    }

    res.json({ valid: true });
  } catch (error) {
    res.status(500).json({ valid: false, error: sanitizeError(error.message) });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object', code: ErrorCode.SCHEDULER_REQUEST_BODY_INVALID });
    }
    const { name, cronExpression, command, serverId } = req.body;
    log.info(`POST /tasks: name=${name}, cron=${cronExpression}, command=${typeof command === 'string' ? command.substring(0, 80) : ''}, serverId=${serverId}`);

    if (!name || !cronExpression || !command) {
      return res.status(400).json({ error: 'Name, cronExpression, and command are required', code: ErrorCode.SCHEDULER_TASK_FIELDS_REQUIRED });
    }

    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'Invalid task name (max 100 chars)', code: ErrorCode.SCHEDULER_INVALID_TASK_NAME });
    }
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 chars)', code: ErrorCode.SCHEDULER_INVALID_COMMAND });
    }
    if (typeof cronExpression !== 'string' || cronExpression.length > 100) {
      return res.status(400).json({ error: 'Invalid cron expression format', code: ErrorCode.SCHEDULER_INVALID_CRON_FORMAT });
    }

    {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(command),
        req,
        res,
      );
      if (!allowed) return;
    }

    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    if (hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").', code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED });
    }

    if (isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes', code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT });
    }

    let resolvedServerId = serverId ?? null;
    if (resolvedServerId) {
      const target = await getServer(resolvedServerId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found', code: ErrorCode.SCHEDULER_TARGET_SERVER_NOT_FOUND });
      }
    } else {
      const active = await getActiveServer();
      resolvedServerId = active ? active.id : null;
    }

    const result = await createScheduledTask(name, cronExpression, command, resolvedServerId);
    const task = {
      id: result.id,
      name,
      cron_expression: cronExpression,
      command,
      server_id: resolvedServerId,
      enabled: 1
    };

    let scheduleResult;
    try {
      scheduleResult = scheduler.scheduleTask(task);
      if (scheduleResult === false) {
        throw new Error("Scheduler rejected the task");
      }
    } catch (schedErr) {
      log.error(`Failed to schedule task, rolling back DB entry: ${schedErr.message}`);
      await deleteScheduledTask(result.id);
      return res.status(500).json({
        error: 'Failed to schedule task: ' + sanitizeError(schedErr.message),
        code: ErrorCode.SCHEDULER_TASK_SCHEDULING_FAILED,
        params: sanitizeErrorParams({ reason: schedErr.message }),
      });
    }

    res.json({ success: true, task, dstWarning: scheduleResult?.dstWarning || null });
  } catch (error) {
    log.error(`Failed to create scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object', code: ErrorCode.SCHEDULER_REQUEST_BODY_INVALID });
    }
    const { name, cronExpression, command, enabled, serverId } = req.body;
    log.info(`PUT /tasks/${id}: name=${name}, cron=${cronExpression}, enabled=${enabled}, serverId=${serverId}`);

    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
      return res.status(400).json({ error: 'Invalid task name (max 100 characters)', code: ErrorCode.SCHEDULER_INVALID_TASK_NAME });
    }
    if (command !== undefined && (typeof command !== 'string' || command.length > 2000)) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)', code: ErrorCode.SCHEDULER_INVALID_COMMAND });
    }
    if (command !== undefined) {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(command),
        req,
        res,
      );
      if (!allowed) return;
    }
    if (
      enabled !== undefined &&
      ![true, false, 0, 1].includes(enabled)
    ) {
      return res.status(400).json({ error: 'enabled must be a boolean or 0/1', code: ErrorCode.SCHEDULER_INVALID_ENABLED_VALUE });
    }
    const normalizedEnabled =
      enabled === undefined ? undefined : (enabled === true || enabled === 1 ? 1 : 0);

    if (cronExpression && !cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression. Use format: minute hour day month weekday (e.g., "0 */6 * * *" for every 6 hours)', code: ErrorCode.SCHEDULER_INVALID_CRON_EXPRESSION });
    }

    if (cronExpression && hasUnsupportedCronFieldCount(cronExpression)) {
      return res.status(400).json({ error: 'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday (e.g., "0 */6 * * *").', code: ErrorCode.SCHEDULER_CRON_SECONDS_UNSUPPORTED });
    }

    if (cronExpression && isCronTooFrequent(cronExpression)) {
      return res.status(400).json({ error: 'Tasks cannot run more frequently than every 5 minutes', code: ErrorCode.SCHEDULER_CRON_TOO_FREQUENT });
    }

    if (serverId !== undefined && serverId !== null) {
      const target = await getServer(serverId);
      if (!target) {
        return res.status(400).json({ error: 'Target server not found', code: ErrorCode.SCHEDULER_TARGET_SERVER_NOT_FOUND });
      }
    }

    const tasksBeforeUpdate = await getScheduledTasks();
    const previousTaskRecord = Array.isArray(tasksBeforeUpdate)
      ? tasksBeforeUpdate.find((task) => String(task.id) === String(taskId))
      : null;
    const previousTask = previousTaskRecord
      ? { ...previousTaskRecord }
      : null;

    const updated = await updateScheduledTask(taskId, name, cronExpression, command, normalizedEnabled, serverId);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }

    let dstWarning = null;
    if (updated.enabled) {
      try {
        const scheduled = scheduler.scheduleTask({
          id: taskId,
          name: updated.name,
          cron_expression: updated.cron_expression,
          command: updated.command,
          server_id: updated.server_id,
          enabled: 1
        });
        if (scheduled === false) {
          throw new Error("Scheduler rejected the updated task");
        }
        dstWarning = scheduled?.dstWarning || null;
      } catch (schedErr) {
        log.error(`Failed to reschedule task ${taskId}, reverting DB: ${schedErr.message}`);
        if (previousTask) {
          try {
            await updateScheduledTask(
              taskId,
              previousTask.name,
              previousTask.cron_expression,
              previousTask.command,
              previousTask.enabled,
              previousTask.server_id,
            );
            if (previousTask.enabled) {
              scheduler.scheduleTask(previousTask);
            } else {
              scheduler.cancelTask(taskId);
            }
          } catch (rollbackError) {
            log.error(
              `Failed to restore scheduled task ${taskId} after reschedule failure: ${rollbackError.message}`,
            );
          }
        } else {
          log.warn(`Could not restore scheduled task ${taskId}: previous record was unavailable`);
        }
        return res.status(500).json({
          error: 'Failed to reschedule task: ' + sanitizeError(schedErr.message),
          code: ErrorCode.SCHEDULER_TASK_RESCHEDULE_FAILED,
          params: sanitizeErrorParams({ reason: schedErr.message }),
        });
      }
    } else {
      scheduler.cancelTask(taskId);
    }

    res.json({ success: true, message: 'Task updated', dstWarning });
  } catch (error) {
    log.error(`Failed to update scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    log.info(`DELETE /tasks/${id}`);

    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    const deleted = await deleteScheduledTask(taskId);
    if (!deleted) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }
    scheduler.cancelTask(taskId);

    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    log.error(`Failed to delete scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/tasks/:id/run', async (req, res) => {
  try {
    const scheduler = req.app.get('scheduler');
    const { id } = req.params;
    const taskId = parseTaskId(id);
    if (taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }

    const tasks = await getScheduledTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found', code: ErrorCode.SCHEDULER_TASK_NOT_FOUND });
    }

    {
      const allowed = await requireCapabilityInline(
        requiredCapabilityForScheduledCommand(task.command),
        req,
        res,
      );
      if (!allowed) return;
    }

    log.info(`POST /tasks/${taskId}/run: ${task.name}`);
    const io = req.app.get('io');
    scheduler.runTaskNow(task)
      .then((result) => {
        emitActionResult(io, {
          kind: 'task',
          taskName: task.name,
          success: !!result?.success,
          message: result?.message || (result?.success ? 'Task completed' : 'Task failed'),
        });
      })
      .catch(err => {
        log.error(`Manual run of task ${taskId} failed: ${err.message}`);
        emitActionResult(io, {
          kind: 'task',
          taskName: task.name,
          success: false,
          message: err.message,
        });
      });

    res.json({ success: true, message: 'Task triggered' });
  } catch (error) {
    log.error(`Failed to run scheduled task: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post('/restart-now', async (req, res) => {
  try {
    const allowed = await requireCapabilityInline('server.control', req, res);
    if (!allowed) return;

    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res.status(400).json({ error: 'Cannot restart a remote server. The process is not managed by this panel.', code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED });
    }

    const scheduler = req.app.get('scheduler');
    const io = req.app.get('io');
    const warningMinutes = req.body?.warningMinutes;

    let parsedWarningMinutes = parseBoundedInteger(
      warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    log.info(`POST /restart-now: warningMinutes=${warningMinutes}`);
    if (parsedWarningMinutes > 60) {
      parsedWarningMinutes = 60;
    }

    scheduler.performRestart(parsedWarningMinutes, { label: 'Manual restart' })
      .then((result) => {
        emitActionResult(io, {
          kind: 'restart',
          success: !!result?.success,
          message: result?.message || (result?.success ? 'Restart completed' : 'Restart failed'),
        });
      })
      .catch(err => {
        log.error(`Restart failed: ${err.message}`);
        emitActionResult(io, {
          kind: 'restart',
          success: false,
          message: err.message,
        });
      });

    res.json({ success: true, message: 'Restart initiated', warningMinutes: parsedWarningMinutes });
  } catch (error) {
    log.error(`Failed to trigger restart: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get('/cron-presets', (req, res) => {
  res.json({
    presets: [
      { name: 'Every hour', cron: '0 * * * *' },
      { name: 'Every 2 hours', cron: '0 */2 * * *' },
      { name: 'Every 4 hours', cron: '0 */4 * * *' },
      { name: 'Every 6 hours', cron: '0 */6 * * *' },
      { name: 'Every 12 hours', cron: '0 */12 * * *' },
      { name: 'Daily at midnight', cron: '0 0 * * *' },
      { name: 'Daily at 6 AM', cron: '0 6 * * *' },
      { name: 'Daily at noon', cron: '0 12 * * *' },
      { name: 'Daily at 6 PM', cron: '0 18 * * *' },
      { name: 'Every 30 minutes', cron: '*/30 * * * *' },
      { name: 'Every 15 minutes', cron: '*/15 * * * *' }
    ]
  });
});

router.get('/history', async (req, res) => {
  try {
    const limit = parseClampedInteger(req.query.limit, 100, 1, 500);
    const taskId =
      req.query.taskId === undefined
        ? null
        : parseBoundedInteger(req.query.taskId, null, 1, Number.MAX_SAFE_INTEGER);
    if (req.query.taskId !== undefined && taskId === null) {
      return res.status(400).json({ error: 'Invalid task ID', code: ErrorCode.SCHEDULER_INVALID_TASK_ID });
    }
    const history = await getScheduleHistory(limit, taskId);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete('/history', async (req, res) => {
  try {
    await clearScheduleHistory();
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    log.error(`Failed to clear schedule history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
