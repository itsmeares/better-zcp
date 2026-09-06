import http from "http";
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from "jose";

export async function makeSigningKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk, kid };
}

export async function startMockOidcProvider({
  clientId,
  defaultSubject = "user-123",
  strictAuth = null,
}) {
  const validKey = await makeSigningKey();
  let baseUrl;
  let nextIdTokenClaims = null;
  let nextSigningKey = null;
  let nextGrantError = null;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function readBasicAuth(req) {
    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Basic ")) return null;
    try {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      const sepIndex = decoded.indexOf(":");
      if (sepIndex === -1) return null;
      return {
        clientId: decodeURIComponent(decoded.slice(0, sepIndex)),
        clientSecret: decodeURIComponent(decoded.slice(sepIndex + 1)),
      };
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [validKey.publicJwk] }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      if (strictAuth) {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const basicAuth = readBasicAuth(req);
        const authClientId = params.get("client_id") || basicAuth?.clientId;
        const authClientSecret = params.get("client_secret") || basicAuth?.clientSecret;
        if (authClientId !== clientId || authClientSecret !== strictAuth.clientSecret) {
          res.statusCode = 401;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed." }));
          return;
        }
        if (params.get("grant_type") === "authorization_code") {
          const grantError = nextGrantError || {
            status: 400,
            error: "invalid_grant",
            error_description: "Authorization code is invalid or expired.",
          };
          res.statusCode = grantError.status;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: grantError.error,
              error_description: grantError.error_description,
            }),
          );
          return;
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: baseUrl,
        aud: clientId,
        sub: defaultSubject,
        iat: now,
        exp: now + 300,
        ...(nextIdTokenClaims || {}),
      };
      const key = nextSigningKey || validKey;
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .sign(key.privateKey);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    validKey,
    setNextIdToken({ claims = null, signingKey = null } = {}) {
      nextIdTokenClaims = claims;
      nextSigningKey = signingKey;
    },
    setNextGrantError(error) {
      nextGrantError = error;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
