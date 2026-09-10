import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LogTailer } from "../services/logTailer.ts";

const isLinux = process.platform !== "win32";

(isLinux ? describe : describe.skip)(
  "LogTailer: real-filesystem rotation handling (server-console.txt truncation, *_chat.txt rotation)",
  () => {
    let dir;
    let tailer;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-logtail-rotation-"));
      tailer = new LogTailer();
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("server-console.txt: a real truncate-and-rewrite (PZ restart) is detected and the tail resets to read the new content from the start", async () => {
      const consolePath = path.join(dir, "server-console.txt");
      fs.writeFileSync(consolePath, "old session line 1\nold session line 2\n");
      tailer.logPath = consolePath;
      tailer.currentSize = fs.statSync(consolePath).size;

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));

      fs.truncateSync(consolePath, 0);
      fs.writeFileSync(consolePath, "new session line 1\n");
      await tailer.checkConsoleLog();
      expect(tailer.currentSize).toBe(0);
      expect(seen).toHaveLength(0);

      fs.appendFileSync(consolePath, "[18-08-26 10:00:05.000] [chat] <Bob> hello after restart\n");
      await tailer.checkConsoleLog();

      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Bob");
      expect(seen[0].message).toBe("hello after restart");
    });

    it("*_chat.txt rotation: PZ starting a new session creates a NEW timestamped chat log; the tailer switches to it and reads its content from the start, not from wherever the old file left off", async () => {
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const oldChat = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(
        oldChat,
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Alice', text='old session'}.\n",
      );

      tailer.watchStartedAt = fs.statSync(oldChat).birthtimeMs + 1000;

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));

      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(oldChat);
      expect(seen).toHaveLength(0);

      const newChat = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        newChat,
        "[01-01-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='Carol', text='new session'}.\n",
      );
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(newChat, future, future);

      await tailer.checkChatLog();

      expect(tailer.chatLogPath).toBe(newChat);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Carol");
      expect(seen[0].message).toBe("new session");

      expect(tailer.chatLogSize).toBe(fs.statSync(newChat).size);
    });

    it("*_chat.txt rotation where the outgoing and incoming session's logs land on the EXACT SAME mtimeMs does not get stuck on the old file", async () => {
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const oldChat = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(
        oldChat,
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Alice', text='old session'}.\n",
      );
      tailer.watchStartedAt = fs.statSync(oldChat).birthtimeMs + 1000;

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(oldChat);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newChat = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        newChat,
        "[01-01-26 11:00:00.000][info] Got message:ChatMessage{chat=Say, author='Carol', text='new session'}.\n",
      );

      const tieTime = new Date();
      fs.utimesSync(oldChat, tieTime, tieTime);
      fs.utimesSync(newChat, tieTime, tieTime);
      expect(fs.statSync(oldChat).mtimeMs).toBe(fs.statSync(newChat).mtimeMs);

      await tailer.checkChatLog();

      expect(tailer.chatLogPath).toBe(newChat);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Carol");
    });

    it("*_chat.txt DELETION mid-tail (real unlink, the exact case the card warns about) does not wedge the tailer on a dead handle -- the next poll simply finds nothing, then picks up a fresh file normally", async () => {
      const logsDir = path.join(dir, "Logs");
      fs.mkdirSync(logsDir);
      tailer.logsDir = logsDir;
      tailer.basePath = dir;

      const chatFile = path.join(logsDir, "01-01-26_chat.txt");
      fs.writeFileSync(chatFile, "");
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(chatFile);

      fs.unlinkSync(chatFile);

      await expect(tailer.checkChatLog()).resolves.toBeUndefined();

      const seen = [];
      tailer.on("chatMessage", (m) => seen.push(m));
      const revived = path.join(logsDir, "02-01-26_chat.txt");
      fs.writeFileSync(
        revived,
        "[01-01-26 12:00:00.000][info] Got message:ChatMessage{chat=Say, author='Dave', text='back up'}.\n",
      );
      await tailer.checkChatLog();
      expect(tailer.chatLogPath).toBe(revived);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Dave");
    });

    it("pure-LF log lines (native Linux line endings, no \\r at all) parse identically to CRLF -- _splitLines' /\\r?\\n/ already accepts both", () => {
      const t = new LogTailer();
      t.chatRemainder = "";
      const seen = [];
      t.on("chatMessage", (m) => seen.push(m));
      const lfOnly =
        "[01-01-26 10:00:00.000][info] Got message:ChatMessage{chat=Say, author='Eve', text='linux native'}.\n";
      t.processChatLogData(lfOnly);
      expect(seen).toHaveLength(1);
      expect(seen[0].author).toBe("Eve");
      expect(seen[0].message).toBe("linux native");
    });

    it("reloadConfig clears the old server paths and resumes watching after an active-server switch", async () => {
      tailer.isWatching = true;
      tailer.basePath = "/old/server";
      tailer.logsDir = "/old/server/Logs";
      tailer.logPath = "/old/server/server-console.txt";
      tailer.chatLogPath = "/old/server/Logs/old_chat.txt";
      tailer.userLogPath = "/old/server/Logs/old_user.txt";
      tailer.consoleRemainder = "old";
      tailer.chatRemainder = "old";
      tailer.userRemainder = "old";
      tailer.checkTimer = setTimeout(() => {}, 60_000);
      const findLogPath = vi.spyOn(tailer, "findLogPath").mockImplementation(async () => {
        tailer.basePath = "/new/server";
      });
      const startWatching = vi.spyOn(tailer, "startWatching").mockResolvedValue();

      await tailer.reloadConfig();

      expect(findLogPath).toHaveBeenCalledOnce();
      expect(startWatching).toHaveBeenCalledOnce();
      expect(tailer.basePath).toBe("/new/server");
      expect(tailer.logPath).toBeNull();
      expect(tailer.chatLogPath).toBeNull();
      expect(tailer.userLogPath).toBeNull();
      expect(tailer.chatRemainder).toBe("");
      expect(tailer.userRemainder).toBe("");
    });
  },
);
