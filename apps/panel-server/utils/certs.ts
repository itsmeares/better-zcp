import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";

const log = createLogger("HTTPS");

const { dataDir } = getDataPaths();
const CERT_DIR = path.join(dataDir, "certs");
const KEY_FILE = path.join(CERT_DIR, "server.key");
const CERT_FILE = path.join(CERT_DIR, "server.cert");

interface CertificatePair {
  key: Buffer;
  cert: Buffer;
}

interface GeneratedCertificate {
  key: string;
  cert: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateSelfSignedCert(): GeneratedCertificate {
  log.info("Generating self-signed certificate...");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const cert = createSelfSignedCertPEM(privateKey, publicKey);

  return { key: privateKey, cert };
}

function createSelfSignedCertPEM(
  privateKeyPem: string,
  publicKeyPem: string,
): string {
  const pubKeyDer = pemToDer(publicKeyPem, "PUBLIC KEY");

  const subject = derSequence([
    derSet([
      derSequence([
        derOID([2, 5, 4, 3]), // commonName
        derUTF8String("Zomboid Control Panel"),
      ]),
    ]),
  ]);

  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const serial = derInteger(crypto.randomBytes(8));

  const sigAlgo = derSequence([
    derOID([1, 2, 840, 113549, 1, 1, 11]), // sha256WithRSAEncryption
    derNull(),
  ]);

  const tbs = derSequence([
    derExplicit(0, derInteger(Buffer.from([2]))), // version v3
    serial,
    sigAlgo,
    subject, // issuer = subject (self-signed)
    derSequence([
      derUTCTime(now),
      derUTCTime(notAfter),
    ]),
    subject, // subject
    pubKeyDer, // subjectPublicKeyInfo (already DER-encoded)
  ]);

  const signer = crypto.createSign("SHA256");
  signer.update(tbs);
  const signature = signer.sign(privateKeyPem);

  const sigBitString = Buffer.concat([
    Buffer.from([0x03, ...derLength(signature.length + 1), 0x00]),
    signature,
  ]);

  const cert = derSequence([tbs, sigAlgo, sigBitString]);

  const b64 = cert.toString("base64");
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function derLength(len: number): number[] {
  if (len < 128) return [len];
  const bytes: number[] = [];
  let tmp = len;
  while (tmp > 0) {
    bytes.unshift(tmp & 0xff);
    tmp >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTag(tag: number, content: Buffer): Buffer {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from([tag, ...derLength(contentBuf.length)]),
    contentBuf,
  ]);
}

function derSequence(items: Buffer[]): Buffer {
  const content = Buffer.concat(
    items.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item))),
  );
  return derTag(0x30, content);
}

function derSet(items: Buffer[]): Buffer {
  const content = Buffer.concat(
    items.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item))),
  );
  return derTag(0x31, content);
}

function derInteger(buf: Buffer): Buffer {
  let value = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let i = 0;
  while (
    i < value.length - 1 &&
    value[i] === 0x00 &&
    !(value[i + 1] & 0x80)
  ) {
    i++;
  }
  value = value.slice(i);
  const needsPad = value[0] & 0x80;
  const content = needsPad
    ? Buffer.concat([Buffer.from([0x00]), value])
    : value;
  return derTag(0x02, content);
}

function derOID(components: number[]): Buffer {
  const bytes = [40 * components[0] + components[1]];
  for (let i = 2; i < components.length; i++) {
    let value = components[i];
    if (value < 128) {
      bytes.push(value);
    } else {
      const encoded: number[] = [];
      encoded.unshift(value & 0x7f);
      value >>= 7;
      while (value > 0) {
        encoded.unshift((value & 0x7f) | 0x80);
        value >>= 7;
      }
      bytes.push(...encoded);
    }
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derUTF8String(str: string): Buffer {
  return derTag(0x0c, Buffer.from(str, "utf8"));
}

function derUTCTime(date: Date): Buffer {
  const y = (date.getUTCFullYear() % 100).toString().padStart(2, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  return derTag(0x17, Buffer.from(`${y}${m}${d}${h}${min}${s}Z`, "ascii"));
}

function derExplicit(tag: number, content: Buffer): Buffer {
  const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from([0xa0 | tag, ...derLength(contentBuf.length)]),
    contentBuf,
  ]);
}

function pemToDer(pem: string, label: string): Buffer {
  const b64 = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}

export function loadOrCreateCerts(
  customKeyPath?: string,
  customCertPath?: string,
): CertificatePair | null {
  if (customKeyPath && customCertPath) {
    try {
      const keyIsFile = fs.statSync(customKeyPath).isFile();
      const certIsFile = fs.statSync(customCertPath).isFile();
      if (keyIsFile && certIsFile) {
        log.info(`Using custom certificates: ${customCertPath}`);
        return {
          key: fs.readFileSync(customKeyPath),
          cert: fs.readFileSync(customCertPath),
        };
      }
      log.warn(
        "Custom certificate paths specified but one or both are not regular files — falling back to self-signed",
      );
    } catch (error: unknown) {
      log.warn(
        `Custom certificate paths specified but could not be read (${errorMessage(error)}) — falling back to self-signed`,
      );
    }
  }

  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    log.info("Using existing self-signed certificate");
    return {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE),
    };
  }

  try {
    if (!fs.existsSync(CERT_DIR)) {
      fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(CERT_DIR, 0o700);
    } catch {
      /* best-effort: Windows / network shares */
    }

    const { key, cert } = generateSelfSignedCert();
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    try {
      fs.chmodSync(KEY_FILE, 0o600);
    } catch {
      /* best-effort: Windows / network shares */
    }
    fs.writeFileSync(CERT_FILE, cert, { mode: 0o644 });

    log.info(`Self-signed certificate generated at ${CERT_DIR}`);
    return { key: Buffer.from(key), cert: Buffer.from(cert) };
  } catch (error: unknown) {
    log.error(`Failed to generate certificate: ${errorMessage(error)}`);
    return null;
  }
}

export function getCertPaths(): {
  keyPath: string;
  certPath: string;
  certDir: string;
} {
  return { keyPath: KEY_FILE, certPath: CERT_FILE, certDir: CERT_DIR };
}
