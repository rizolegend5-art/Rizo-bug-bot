import fs from "fs";
import path from "path";
import { Bot } from "grammy";
import { run } from "@grammyjs/runner";

import { BOT_TOKEN, OWNER_ID, BRANDING } from "./config/config.js";
import { log } from "./bot/logger.js";
import { restoreDeployedBots, reloadDeployedBots } from "./bot/deploy.js";
import {
  loadAllWhatsappSessions,
  shutdownWhatsappSessions,
} from "./bot/whatsapp.js";
import { getUsers } from "./data/database.js";

let bot;
let runner;
let reloadTimer = null;
let isReloading = false;
let isStopping = false;
let lastSuppressedLogAt = 0;

function isNoisyBaileysTimerError(err) {
  const message = err?.message || "";
  const stack = err?.stack || "";
  const statusCode = err?.output?.statusCode ?? err?.data?.output?.statusCode;

  const isConnectionClosed =
    message === "Connection Closed" || statusCode === 428;
  const isFromInternalTimer =
    /baileys/i.test(stack) &&
    /(newsletter|Timeout\._onTimeout|listOnTimeout)/i.test(stack);

  return isConnectionClosed && isFromInternalTimer;
}

async function notifyOwnerCrash(label, err) {
  if (isNoisyBaileysTimerError(err)) {
    const now = Date.now();
    if (now - lastSuppressedLogAt > 60000) {
      log.warning("Ignored Baileys timer error: the socket was already closed.");
      lastSuppressedLogAt = now;
    }
    return;
  }

  const detail = err?.stack || err?.message || String(err);
  log.error(`${label}: ${detail}`);

  if (!OWNER_ID) return;

  try {
    await bot.api.sendMessage(
      OWNER_ID,
      `🚨 *${label}*\n\n\`\`\`\n${detail.slice(0, 3000)}\n\`\`\``,
      { parse_mode: "Markdown" },
    );
  } catch { }
}

function loadUsersOnStartup() {
  const users = getUsers();
  log.success(`${users.length} users loaded from the database`);
  return users;
}

async function createMainBot() {
  const { registerBotHandlers } = await import(
    `./bot/handlers/index.js?reload=${Date.now()}`
  );

  const nextBot = new Bot(BOT_TOKEN);
  await registerBotHandlers(nextBot, { isSubBot: false });
  return nextBot;
}

async function startMainBot() {
  bot = await createMainBot();
  runner = run(bot);
  runner.task()?.catch(handleRunnerError);
  log.success(`${BRANDING.name} main runner started (concurrent mode)`);
}

function isTelegramConflict(err) {
  return (
    err?.error_code === 409 ||
    /409:\s*Conflict|other getUpdates request/i.test(err?.message || "")
  );
}

async function handleRunnerError(err) {
  if (isTelegramConflict(err)) {
    log.error(
      "Main bot stopped: this token is being used by another instance (Telegram 409). Stop the duplicate process and restart.",
    );
  } else {
    await notifyOwnerCrash("TELEGRAM RUNNER FAILED", err);
  }

  await shutdownWhatsappSessions();
  process.exitCode = 1;
  process.exit();
}

function watchSourceFile(fileName) {
  const filePath = path.join(process.cwd(), "src", "bot", fileName);

  fs.watch(filePath, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadBotCode(fileName), 500);
  });
}

async function reloadBotCode(fileName) {
  if (isReloading) return;

  isReloading = true;
  log.warning(`${fileName} changed; reloading Telegram handlers...`);

  try {
    if (runner?.isRunning()) await runner.stop();
    await startMainBot();
    await reloadDeployedBots();
    log.success("Telegram handlers reloaded without restarting WhatsApp sessions.");
  } catch (err) {
    log.error(`Hot reload failed for ${fileName}: ${err.message}`);
  } finally {
    isReloading = false;
  }
}

const stopRunner = async () => {
  if (isStopping) return;
  isStopping = true;
  log.warning("Stopping the main bot...");

  if (runner?.isRunning()) {
    await runner.stop();
  }

  await shutdownWhatsappSessions();
  process.exit(0);
};

process.on("unhandledRejection", (reason) => {
  notifyOwnerCrash("UNHANDLED REJECTION", reason);
});

process.on("uncaughtException", (err) => {
  notifyOwnerCrash("UNCAUGHT EXCEPTION", err);
});

await startMainBot();

(async () => {
  const runBackgroundTask = async (label, task) => {
    try {
      await task();
    } catch (err) {
      log.error(`${label} failed: ${err?.stack || err?.message || err}`);
    }
  };

  await runBackgroundTask("WhatsApp session restore", async () => {
    await loadAllWhatsappSessions(bot);
  });

  await runBackgroundTask("User database load", async () => {
    await loadUsersOnStartup();
  });

  await runBackgroundTask("Deployed bot restore", async () => {
    await restoreDeployedBots(bot);
  });
})();

log.whatsapp(`${BRANDING.name} is ready 🚀`);
watchSourceFile("menu.js");
watchSourceFile("handlers/index.js");

process.once("SIGINT", stopRunner);
process.once("SIGTERM", stopRunner);
