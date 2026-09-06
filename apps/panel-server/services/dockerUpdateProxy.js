import http from "http";
import https from "https";

const REQUEST_TIMEOUT_MS = 15000;

function postJson(urlString, token, payload) {
  return new Promise((resolve, reject) => {
    let target;
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
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          let parsed = {};
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch {
            reject(new Error("Docker update controller returned invalid JSON"));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                parsed.error ||
                  `Docker update controller returned HTTP ${response.statusCode}`,
              ),
            );
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
  constructor() {
    this.url = (process.env.PANEL_DOCKER_UPDATER_URL || "").replace(/\/+$/, "");
    this.token = process.env.PANEL_DOCKER_UPDATER_TOKEN || "";
    this.isApplying = false;
  }

  get enabled() {
    return Boolean(this.url && this.token);
  }

  get mode() {
    return this.enabled ? "docker" : "binary";
  }

  async apply(version) {
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
      // `success: true` here means only that the update controller ACCEPTED
      // the request (its own response is a plain HTTP 202) -- it does NOT
      // mean the update completed. The controller has its own
      // success/failed/rollback state machine (infra/docker/all-in-one/updater's
      // own server.js) and can fail and roll itself back well after this
      // call already returned; this process has no way to learn which one
      // happened, since polling the controller's own /status endpoint for
      // that answer is a separate, not-yet-built feature (a one-shot check
      // at the NEW container's next boot, since THIS process is what gets
      // torn down mid-update -- it cannot poll for its own answer). Until
      // that exists, the message must never claim more than "started".
      return {
        success: true,
        message: `${result.message || `Docker update to v${version} started`} — the panel cannot confirm this Docker update completed; check the panel container's own status or logs.`,
      };
    } finally {
      this.isApplying = false;
    }
  }
}