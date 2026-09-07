import http, { type IncomingMessage } from "http";
import https from "https";

const REQUEST_TIMEOUT_MS = 15000;

function postJson(
  urlString: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(urlString);
    } catch {
      reject(new Error("Docker update controller URL is invalid"));
      return;
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      reject(new Error("Docker update controller URL must use HTTP or HTTPS"));
      return;
    }

    const body = JSON.stringify(payload);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response: IncomingMessage) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch {
            reject(new Error("Docker update controller returned invalid JSON"));
            return;
          }

          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            const error =
              typeof parsed.error === "string"
                ? parsed.error
                : `Docker update controller returned HTTP ${response.statusCode}`;
            reject(new Error(error));
            return;
          }
          resolve(parsed);
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Docker update controller timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export class DockerUpdateProxy {
  url: string;
  token: string;
  isApplying: boolean;

  constructor() {
    this.url = (process.env.PANEL_DOCKER_UPDATER_URL || "").replace(/\/+$/, "");
    this.token = process.env.PANEL_DOCKER_UPDATER_TOKEN || "";
    this.isApplying = false;
  }

  get enabled(): boolean {
    return Boolean(this.url && this.token);
  }

  get mode(): "docker" | "binary" {
    return this.enabled ? "docker" : "binary";
  }

  async apply(version: string): Promise<
    | { success: false; error: string; code: string }
    | { success: true; message: string }
  > {
    if (!this.enabled) {
      return {
        success: false,
        error: "Docker update controller is not configured",
        code: "docker_updater_not_configured",
      };
    }
    if (this.isApplying) {
      return {
        success: false,
        error: "A Docker update is already in progress",
        code: "apply_in_progress",
      };
    }

    this.isApplying = true;
    try {
      const result = await postJson(`${this.url}/update`, this.token, {
        version,
      });
      const message =
        typeof result.message === "string"
          ? result.message
          : `Docker update to v${version} started`;
      return {
        success: true,
        message: `${message} — the panel cannot confirm this Docker update completed; check the panel container's own status or logs.`,
      };
    } finally {
      this.isApplying = false;
    }
  }
}
