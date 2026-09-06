import { describe, expect, it } from "vitest";
import express from "express";
import { parseTrustProxySetting } from "../utils/trustProxy.js";

describe("parseTrustProxySetting", () => {
  it.each(["", "0", "false", "off", "none"])(
    "disables proxy trust for %j",
    (value) => {
      expect(parseTrustProxySetting(value)).toBe(false);
    },
  );

  it("maps true to one trusted hop instead of Express's unsafe trust-all mode", () => {
    expect(parseTrustProxySetting("true")).toBe(1);
  });

  it.each([
    ["1", 1],
    ["2", 2],
  ])("parses %j as %i trusted hops", (value, expected) => {
    expect(parseTrustProxySetting(value)).toBe(expected);
  });

  it("accepts an IP or subnet list supported by Express", () => {
    const setting = parseTrustProxySetting("127.0.0.1, 10.0.0.0/8");
    const app = express();

    app.set("trust proxy", setting);

    expect(setting).toEqual(["127.0.0.1", "10.0.0.0/8"]);
    expect(app.get("trust proxy")).toEqual(setting);
  });

  it.each(["-1", "9007199254740992"])(
    "does not enable an invalid numeric value %j",
    (value) => {
      expect(parseTrustProxySetting(value)).toBe(false);
    },
  );
});