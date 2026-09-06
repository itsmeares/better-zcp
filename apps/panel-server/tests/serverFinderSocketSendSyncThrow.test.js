import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryMasterServer, queryServerInfo } from "../routes/serverFinder.js";

// 2026-08-30, serverfinder-crash: queryMasterServer()'s sendQuery() calls
// socket.send(packet) from inside socket.connect()'s callback (and, on
// pagination, from inside the 'message' listener) -- neither is inside this
// function's own `new Promise((resolve, reject) => ...)` executor. A
// SYNCHRONOUS throw from send() (observed in production: RangeError
// [ERR_SOCKET_BAD_PORT]) therefore reaches neither `reject` above nor the
// socket's own 'error' listener -- it becomes a genuine, uncaught Node
// exception, and Node's default handling of that KILLS THE WHOLE SERVER
// PROCESS, not just this one request. Confirmed for real, twice, via
// a manual browser smoke test: the first hit didn't
// crash (looked clean), the second did, several seconds after the page had
// already rendered -- invisible to manual QA, which is why it survived.
//
// The point of THIS test is proving the real mechanism, not a simulated
// one: it forces socket.send() to throw synchronously (the exact production
// error), then asserts BOTH that the returned promise still settles (does
// not hang forever, which is what "escapes the executor" looks like from
// the outside) AND that no process-level 'uncaughtException' fired (which
// is what "escapes the process" looks like). A test that only asserted
// "the promise rejects" would not catch a regression back to the unguarded
// code, because on unguarded code the promise never rejects at all -- it
// just never settles, while the process crashes underneath the test.
//
// Break-verify: reverting the try/catch in serverFinder.js's sendQuery()
// back to a bare `socket.send(packet)` makes this test RED -- the race
// against the 2s timeout resolves 'timeout' (the promise never settles)
// and `uncaught` captures the real RangeError (confirmed 2026-08-30).

function interceptFirstSendToThrow(count = 1) {
  const originalCreateSocket = dgram.createSocket;
  let calls = 0;
  dgram.createSocket = (...args) => {
    const sock = originalCreateSocket(...args);
    const realSend = sock.send.bind(sock);
    sock.send = (...sendArgs) => {
      calls += 1;
      if (calls <= count) {
        // The exact production error, thrown synchronously -- not a
        // rejected promise, not an emitted 'error' event.
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

    // Not "timeout" -- on the unfixed code this is exactly what a hung,
    // never-settled promise looks like from the caller's side.
    expect(result.settled).toBe("rejected");
    expect(result.err).toBeInstanceOf(RangeError);
    expect(result.err.message).toMatch(/Port should be > 0/);
    // Not just "the promise did the right thing" -- the process itself
    // must never have seen this as an uncaught exception either.
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
