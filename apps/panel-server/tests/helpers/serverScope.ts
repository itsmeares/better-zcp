import { it } from "vite-plus/test";
import { runForServer } from "../../utils/serverScope.ts";

export function scopedTests(serverId: string | (() => Promise<string>)) {
  const wrap =
    (operation: (...args: any[]) => unknown) =>
    async (...args: any[]) => {
      const id = typeof serverId === "string" ? serverId : await serverId();
      return runForServer(id, () => operation(...args));
    };
  return Object.assign(
    (name, operation, ...options) => it(name, wrap(operation), ...options),
    {
      each:
        (cases) =>
        (name, operation, ...options) =>
          it.each(cases)(name, wrap(operation), ...options),
    },
  );
}
