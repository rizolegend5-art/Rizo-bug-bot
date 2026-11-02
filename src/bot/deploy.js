import { Bot } from "grammy";
import { run } from "@grammyjs/runner";

import { log } from "./logger.js";
import { getAllBotsRaw, removeBotEntry } from "../data/database.js";
import {
  sharedSessionKeyFromToken,
  restoreSessionsForKey,
} from "./whatsapp.js";

export const deployedBots = new Map();
let notificationBot = null;

async function notifyBotOwner(ownerId, token, errorText) {
  if (!ownerId || !notificationBot?.api) return;

  try {
    await notificationBot.api.sendMessage(
      String(ownerId),
      `⚠️ Your deployed bot was stopped and removed automatically.\nToken suffix: ...${String(token).slice(-6)}\nReason: ${errorText}`,
    );
  } catch (error) {
    log.warning(
      `Could not notify deployed bot owner ${ownerId}: ${error.message}`,
    );
  }
}

async function removeFailedBot(token, error) {
  const entry = deployedBots.get(token);
  if (entry) await stopDeployedBot(token);

  const records = getAllBotsRaw();
  for (const [deployerUid, bots] of Object.entries(records)) {
    if (bots.some((botEntry) => botEntry.token === token)) {
      removeBotEntry(deployerUid, token);
    }
  }

  const reason = describeDeployError(error);
  log.error(`Sub-bot removed (...${String(token).slice(-6)}): ${reason}`);
  await notifyBotOwner(entry?.ownerId, token, reason);
}

async function loadHandlersModule() {
  return import(`./handlers/index.js?reload=${Date.now()}`);
}

export function describeDeployError(err) {
  const statusCode =
    err?.error_code ?? err?.response?.error_code ?? err?.output?.statusCode;
  const message = String(
    err?.description || err?.message || err || "Unknown error",
  );

  if (
    statusCode === 401 ||
    /unauthorized|invalid token|token is invalid/i.test(message)
  ) {
    return "The bot token is invalid or has been revoked. Check the token in BotFather.";
  }

  if (statusCode === 409 || /conflict|getupdates|webhook/i.test(message)) {
    return "The bot is already used by another process or still has an active webhook.";
  }

  if (/timeout|timed out|etimedout|network|fetch failed/i.test(message)) {
    return "Telegram could not be reached. Check the server connection and try again.";
  }

  return message.slice(0, 500);
}

export async function startDeployedBot(token, ownerId, deployerUid) {
  if (deployedBots.has(token)) {
    return deployedBots.get(token).bot;
  }

  const subBot = new Bot(token);
  const { registerBotHandlers } = await loadHandlersModule();

  await registerBotHandlers(subBot, {
    isSubBot: true,
    subBotOwnerId: String(ownerId),
    subBotToken: token,
  });

  subBot.catch((err) => {
    const reason = describeDeployError(err);
    const tokenSuffix = `...${token.slice(-6)}`;

    if (reason.startsWith("Telegram could not be reached.")) {
      log.warning(
        `Temporary Telegram API/network error for sub-bot (${tokenSuffix}). The clone remains registered; check server connectivity and retry the failed action.`,
      );
      return;
    }

    log.error(`Sub-bot error (${tokenSuffix}): ${reason}`);
  });

  try {
    await subBot.init();
  } catch (err) {
    try {
      await subBot.stop();
    } catch { }

    throw new Error(`Bot initialization failed: ${describeDeployError(err)}`);
  }

  const handle = run(subBot);
  const entry = {
    bot: subBot,
    handle,
    ownerId: String(ownerId),
    deployerUid: String(deployerUid),
  };
  deployedBots.set(token, entry);

  handle.task()?.catch((err) => {
    if (deployedBots.get(token) !== entry) return;
    void removeFailedBot(token, err);
  });

  log.success(
    `Sub-bot active (concurrent mode) | Owner: ${ownerId} | Deployer: ${deployerUid}`,
  );

  const sessionKey = sharedSessionKeyFromToken(token);

  try {
    await restoreSessionsForKey(subBot, sessionKey, ownerId);
  } catch (err) {
    await stopDeployedBot(token);
    throw new Error(`Bot session restore failed: ${describeDeployError(err)}`);
  }

  return subBot;
}

export async function reloadDeployedBots() {
  for (const token of [...deployedBots.keys()]) {
    const entry = deployedBots.get(token);
    if (!entry) continue;

    try {
      await stopDeployedBot(token);
      await startDeployedBot(token, entry.ownerId, entry.deployerUid);
    } catch (err) {
      const reason = describeDeployError(err);
      log.error(
        `Sub-bot reload failed (...${token.slice(-6)}): ${reason}`,
      );
      removeBotEntry(entry.deployerUid, token);
      await notifyBotOwner(entry.ownerId, token, reason);
    }
  }
}

export async function stopDeployedBot(token) {
  const entry = deployedBots.get(token);
  if (!entry) return false;

  deployedBots.delete(token);

  try {
    if (entry.handle?.isRunning?.()) {
      await entry.handle.stop();
    }
  } catch { }

  log.warning(`Sub-bot stopped (...${token.slice(-6)})`);
  return true;
}

export async function restoreDeployedBots(mainBot = notificationBot) {
  notificationBot = mainBot || notificationBot;
  const all = getAllBotsRaw();
  const entries = Object.entries(all);

  if (!entries.length) {
    log.warning("No deployed bots found; skipping restore.");
    return;
  }

  let success = 0;
  let failed = 0;
  const seenTokens = new Set();

  for (const [deployerUid, bots] of entries) {
    for (const botEntry of bots) {
      if (seenTokens.has(botEntry.token)) {
        failed += 1;
        removeBotEntry(deployerUid, botEntry.token);
        log.error(
          `Duplicate sub-bot entry removed (...${botEntry.token.slice(-6)})`,
        );
        await notifyBotOwner(
          botEntry.ownerId,
          botEntry.token,
          "The same token was registered more than once.",
        );
        continue;
      }
      seenTokens.add(botEntry.token);

      try {
        await startDeployedBot(botEntry.token, botEntry.ownerId, deployerUid);
        success += 1;
      } catch (err) {
        failed += 1;
        log.error(
          `Sub-bot restore failed (...${botEntry.token.slice(-6)}): ${describeDeployError(err)}`,
        );
        removeBotEntry(deployerUid, botEntry.token);
        await notifyBotOwner(botEntry.ownerId, botEntry.token, describeDeployError(err));
      }
    }
  }

  log.success(
    `Sub-bot restore complete — 🟢 ${success} successful, 🔴 ${failed} failed`,
  );
}
