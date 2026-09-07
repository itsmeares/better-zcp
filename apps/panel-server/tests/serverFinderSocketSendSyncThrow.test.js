import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryMasterServer, queryServerInfo } from "../routes/serverFinder.ts";


function interceptFirstSendToThrow(count = 1) {
  const originalCreateSocket = dgram.createSocket;
  let calls = 0;
  dgram.createSocket = (...args) => {
    const sock = originalCreateSocket(...args);
    const realSend = sock.send.bind(sock);
    sock.send = (...sendArgs) => {
      calls += 1;
      if (calls <= count) {
        throw new RangeError(
          "Port should be > 0 and < 65536. Received undefined.",
        );
      }
      return realSend(...sendArgs);
    };
    return sock;
  };
  return () => {
    dgram.createSocket = originalCreateSocket;
  };
}

async function withUncaughtExceptionCapture(fn) {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    return { uncaught, result: await fn() };
  } finally {
    process.off("uncaughtException", onUncaught);
  }
}

describe("serverFinder.js: a synchronous throw from socket.send() no longer escapes as an uncaught, process-killing exception", () => {
  let peer;
  let restoreCreateSocket;

  afterEach(() => {
    peer?.close();
    peer = null;
    restoreCreateSocket?.();
    restoreCreateSocket = null;
  });

  it("queryMasterServer: sendQuery()'s send() inside connect()'s callback rejects cleanly instead of hanging/crashing", async () => {
    peer = dgram.createSocket("udp4");
    await new Promise((resolve) => peer.bind(0, "127.0.0.1", resolve));
    const peerPort = peer.address().port;

    restoreCreateSocket = interceptFirstSendToThrow(1);

    const { uncaught, result } = await withUncaughtExceptionCapture(() =>
      Promise.race([
        queryMasterServer("127.0.0.1", peerPort, 0xff, "\\appid\\108600")
          .then((value) => ({ settled: "resolved", value }))
          .catch((err) => ({ settled: "rejected", err })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ settled: "timeout" }), 2000),
        ),
      ]),
    );

    expect(result.settled).toBe("rejected");
    expect(result.err).toBeInstanceOf(RangeError);
    expect(result.err.message).toMatch(/Port should be > 0/);
    expect(uncaught).toEqual([]);
  });

  it("queryServerInfo: the initial send() inside connect()'s callback resolves null via onFailureReason instead of hanging/crashing", async () => {
    peer = dgram.createSocket("udp4");
    await new Promise((resolve) => peer.bind(0, "127.0.0.1", resolve));
    const peerPort = peer.address().port;

    restoreCreateSocket = interceptFirstSendToThrow(1);

    let failureReason = null;
    const { uncaught, result } = await withUncaughtExceptionCapture(() =>
      Promise.race([
        queryServerInfo("127.0.0.1", peerPort, (reason) => {
          failureReason = reason;
        }).then((value) => ({ settled: "resolved", value })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ settled: "timeout" }), 2000),
        ),
      ]),
    );

    expect(result.settled).toBe("resolved");
    expect(result.value).toBeNull();
    expect(failureReason).toBe("socket-error");
    expect(uncaught).toEqual([]);
  });
});
