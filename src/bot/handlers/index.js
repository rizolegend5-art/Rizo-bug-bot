import { log } from "../logger.js";
import { createHandlerRuntime } from "./runtime.js";
import { registerCommandHandlers } from "./commands.js";
import { registerCallbackHandlers } from "./callbacks.js";
import {
  OWNER_USERNAME,
  MENU_VIDEO_URL,
  MENU_PHOTO_URL,
  MENU_MEDIA_URL,
  MENU_MEDIA_TYPE,
  BRANDING,
  FORCE_JOIN_CHANNELS,
} from "../../config/config.js";
import { isOwner } from "../../data/database.js";
import { sharedSessionKeyFromToken } from "../whatsapp.js";

export async function registerBotHandlers(bot, opts = {}) {
  const { createMenuModule } = await import(`../menu.js?reload=${Date.now()}`);

  const isSubBot = !!opts.isSubBot;
  const subBotOwnerId = opts.subBotOwnerId ? String(opts.subBotOwnerId) : null;
  const subBotToken = opts.subBotToken || null;
  const dbScope =
    isSubBot && subBotToken
      ? sharedSessionKeyFromToken(subBotToken)
      : undefined;
  const checkOwner = (uid) =>
    isSubBot ? String(uid) === subBotOwnerId : isOwner(uid);

  const menu = createMenuModule(bot, {
    isSubBot,
    subBotOwnerId,
    OWNER_USERNAME,
    MENU_VIDEO_URL,
    MENU_PHOTO_URL,
    MENU_MEDIA_URL,
    MENU_MEDIA_TYPE,
    BRANDING,
    FORCE_JOIN_CHANNELS,
    checkOwner,
    dbScope,
  });

  const runtime = createHandlerRuntime(bot, menu, {
    isSubBot,
    subBotOwnerId,
    subBotToken,
  });

  registerCommandHandlers(bot, runtime, menu, {
    isSubBot,
    subBotOwnerId,
    subBotToken,
  });
  registerCallbackHandlers(bot, runtime, menu);

  bot.catch((err) => {
    const label = isSubBot ? `Sub-bot (${subBotOwnerId})` : "Main bot";
    log.error(`${label} error: ${err.message}`);
  });
}
