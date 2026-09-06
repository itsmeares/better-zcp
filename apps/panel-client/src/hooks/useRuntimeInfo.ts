import { useEffect, useState } from "react";
import { systemApi, type RuntimeInfo } from "@/lib/api";

let cachedRuntime: RuntimeInfo | null = null;
let runtimeRequest: Promise<RuntimeInfo> | null = null;

export function platformTranslationKey(
  baseKey: string,
  family: RuntimeInfo["family"] | undefined,
): string {
  if (family === "windows") return `${baseKey}Windows`;
  if (family === "posix") return `${baseKey}Posix`;
  return baseKey;
}

export function useRuntimeInfo(): RuntimeInfo | null {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(cachedRuntime);

  useEffect(() => {
    let cancelled = false;
    const getRuntime = systemApi?.getRuntime;
    if (typeof getRuntime !== "function") return undefined;
    if (!runtimeRequest) {
      runtimeRequest = getRuntime().then((value) => {
        cachedRuntime = value;
        return value;
      }).catch((error) => {
        runtimeRequest = null;
        throw error;
      });
    }
    runtimeRequest.then((value) => {
      if (!cancelled) setRuntime(value);
    }).catch(() => {
      // Unknown platform deliberately keeps neutral copy.
    });
    return () => { cancelled = true; };
  }, []);

  return runtime;
}

export function resetRuntimeInfoForTests(): void {
  cachedRuntime = null;
  runtimeRequest = null;
}
