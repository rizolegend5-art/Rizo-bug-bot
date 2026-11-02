import {
  isOwner,
  isAdmin,
  canUseBot,
  addAdmin,
  removeAdmin,
  getAdmins,
  addPremium,
  removePremium,
  getPremiums,
  isPremium,
  addVVIP,
  removeVVIP,
  getVVIPs,
  getVVIPEntry,
  isVVIP,
  getMode,
  parseDuration,
  formatDuration,
  setMode,
  getPairsForUser,
  addPairNumber,
  getAllPairs,
  removePairNumber,
  clearAllPairs,
  getUsers,
  removeUser,
  addUser,
  getBotsForUser,
  getAllBotsRaw,
  addBotEntry,
  removeBotEntry,
  findBotOwnerUid,
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "../../data/database.js";
import { InputFile } from "grammy";
import fs from "fs";
import path from "path";
import travas, {
  getTravasEntry,
  getTravasRegistry,
  normalizeTravasTarget,
  resolveGroupInviteTarget,
} from "../travas.js";
import { log } from "../logger.js";
import {
  initWhatsappForNumber,
  endWhatsappForNumber,
  clearAllSessions,
  getClient,
  waClients,
  clientKey,
  waitForPairSuccess as waitUntilOpen,
  sharedSessionKeyFromToken,
  describeWhatsappError,
} from "../whatsapp.js";
import {
  getVVIPUseState,
  consumeVVIPSenderUse,
  resetVVIPSenderUse,
  formatCooldownText,
} from "../vvipCooldown.js";
import {
  BOT_TOKEN,
  OWNER_ID,
  OWNER_USERNAME,
  MENU_VIDEO_URL,
  MENU_PHOTO_URL,
  MENU_MEDIA_URL,
  MENU_MEDIA_TYPE,
  MAX_PAIR_PER_USER,
  FORCE_JOIN_CHANNELS,
  BRANDING,
} from "../../config/config.js";

export function registerCommandHandlers(bot, runtime, menu, opts = {}) {
  const pendingDatabaseRestore = new Map();
  const {
    isSubBot,
    subBotOwnerId,
    subBotToken,
    checkOwner,
    checkAdmin,
    checkAccess,
    dbScope,
    getSessionKey,
    resolveSessionKey,
    describeAssenderTarget,
    normalizeAssenderTarget,
    sanitizePhoneDigits,
    registerUserIfNeeded,
    backupUsersJsonToOwner,
    travasRun,
    actionSession,
    sendDoneCard,
    sendVVIPSelectorMenu,
    pendingAction,
    pendingTravasTarget,
    pairingLocks,
    ownerActingAs,
    getActingTarget,
    isUsingExternalSender,
  } = runtime;

  const parseRoleTargetAndDuration = (args) => {
    const raw = args.join(" ").trim();
    const commaIndex = raw.indexOf(",");

    if (commaIndex >= 0) {
      return {
        target: raw.slice(0, commaIndex).trim(),
        duration: raw.slice(commaIndex + 1).trim(),
      };
    }

    return {
      target: args[0]?.trim() || "",
      duration: args[1]?.trim() || "",
    };
  };
  const isTelegramUserId = (value) => /^\d+$/.test(String(value || "").trim());

  const {
    sendStartMenu,
    sendActionMenu,
    sendAllMenu,
    sendMyInfoMenu,
    sendSXTable,
    isUserJoinedChannel,
    joinChannelKeyboard,
    sendJoinRequiredMenu,
    botReply,
    botError,
    botSucces,
    botList,
    sendTextResult,
    streamBlocks,
  } = menu;

  // ====================================================================
  // Build command map dari TRAVAS_REGISTRY — dipakai dynamic dispatcher
  // ====================================================================
  // Format command di registry bisa "xcombo" atau "/xcombo".
  // Kita normalize supaya bisa dicocokkan dengan `command` (tanpa slash).
  const buildTravasCommandMap = () => {
    const map = new Map();
    for (const entry of getTravasRegistry()) {
      const raw = String(entry.command || entry.key || "");
      const key = raw.replace(/^\//, "").toLowerCase();
      if (key) map.set(key, entry);
    }
    return map;
  };
  const travasCommandMap = buildTravasCommandMap();

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const uid = String(ctx.from.id);
    const pendingTravas = pendingTravasTarget.get(uid);

    // ------------------------------------------------------------------
    // Pending travas target (user sudah pilih action, sekarang kirim target)
    // ------------------------------------------------------------------
    if (pendingTravas && !text.startsWith("/")) {
      pendingTravasTarget.delete(uid);

      const entry = getTravasEntry(pendingTravas.key);
      if (!entry) {
        return botError(ctx, "The selected travas action is no longer valid.");
      }

      let target = normalizeTravasTarget(entry.type, text);

      if (entry.type === "group" && !target.endsWith("@g.us")) {
        const sessionKey = resolveSessionKey(uid);
        const sessions = getPairsForUser(sessionKey);
        const active = sessions.find(
          (num) => getClient(sessionKey, num)?.status === "open",
        );

        if (!active) {
          return botError(
            ctx,
            "No active sender is available for group resolution.",
            "⚠️ OFFLINE",
          );
        }

        const sock = getClient(sessionKey, active)?.sock;
        const resolved = await resolveGroupInviteTarget(sock, target);
        if (!resolved) {
          return botError(
            ctx,
            "Invalid group link or group JID. Send a WhatsApp invite link or a valid @g.us group ID.",
            "⚠️ INVALID GROUP TARGET",
          );
        }
        target = resolved;
      }

      if (!target) {
        return botError(ctx, `Invalid ${entry.type} target. Try again.`);
      }

      await ctx.api
        .deleteMessage(ctx.chat.id, ctx.message.message_id - 1)
        .catch(() => {});

      const sessionKey = resolveSessionKey(uid);
      await actionSession(
        ctx,
        uid,
        sessionKey,
        target,
        (sock, finalTarget) => entry.run({ sock, target: finalTarget }),
        entry.key,
      );
      return;
    }

    // Hanya proses command diawali /
    if (!text.startsWith("/")) return;

    const [cmdRaw, ...args] = text.split(/\s+/);
    const command = cmdRaw.slice(1).toLowerCase();

    await registerUserIfNeeded(uid);

    // ------------------------------------------------------------------
    // Cek wajib join channel (kecuali subbot & owner)
    // ------------------------------------------------------------------
    if (!isSubBot && !checkOwner(uid)) {
      const joined = await isUserJoinedChannel(uid);
      if (!joined) {
        await sendJoinRequiredMenu(
          ctx,
          "You must join the required channel before using this bot.",
        );
        return;
      }
    }

    // ------------------------------------------------------------------
    // DYNAMIC TRAVAS DISPATCHER
    // ------------------------------------------------------------------
    // Kalau command cocok dengan entry di TRAVAS_REGISTRY → jalankan
    // otomatis sesuai type (number / group / channel).
    // Travas baru tinggal tambah di registry, tidak perlu edit command.js.
    // ------------------------------------------------------------------
    const travasEntry = travasCommandMap.get(command);
    if (travasEntry) {
      if (!checkAccess(uid)) return botError(ctx, "You do not have access.");

      await travasRun(
        ctx,
        uid,
        args,
        command,
        travasEntry.type,
        (sock, target) => travasEntry.run({ sock, target }),
      );
      return;
    }

    // ------------------------------------------------------------------
    // SWITCH-CASE COMMANDS (non-travas)
    // ------------------------------------------------------------------
    switch (command) {
      // ==================================================================
      // MENU
      // ==================================================================
      case "start": {
        await sendStartMenu(ctx);
        break;
      }

      case "menu": {
        await sendAllMenu(ctx);
        break;
      }

      case "action": {
        await sendActionMenu(ctx);
        break;
      }

      case "myinfo": {
        await sendMyInfoMenu(ctx);
        break;
      }

      // ==================================================================
      // PREMIUM
      // ==================================================================
      case "addprem": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");

        const { target, duration: durasiRaw } =
          parseRoleTargetAndDuration(args);

        if (!isTelegramUserId(target)) {
          return botError(
            ctx,
            "Usage: /addprem <user_id>[,<duration>]\nExample: /addprem 12345,1d or /addprem 12345 1d\nUse a numeric Telegram user ID. Units: m(minutes), h(hours), d(days), w(weeks), mo(months), y(years). Use 0 or leave the duration empty for permanent access.",
            "⚠️ INVALID FORMAT",
          );
        }

        let durationMs = null;
        if (durasiRaw) {
          const parsed = parseDuration(durasiRaw);
          if (parsed === undefined) {
            return botError(
              ctx,
              "Invalid duration. Use 1d, 12h, 30m, 2w, 1mo, 1y, or 0 for permanent access.",
              "⚠️ INVALID FORMAT",
            );
          }
          durationMs = parsed;
        }

        const entry = addPremium(target, durationMs, dbScope);
        await botSucces(
          ctx,
          `${target} was added as a premium user${isSubBot ? " (this bot only)" : ""}.\nDuration: ${entry.expiresAt ? formatDuration(entry.expiresAt - Date.now()) : "Permanent"}`,
        );
        break;
      }

      case "delprem": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");
        const target = args[0]?.trim();
        if (!isTelegramUserId(target))
          return botError(ctx, "Usage: /delprem <user_id>", "⚠️ INVALID FORMAT");
        removePremium(target, dbScope);
        await botSucces(ctx, `${target} was removed from premium.`);
        break;
      }

      case "listprem": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");
        const premiums = getPremiums(dbScope);
        const items = premiums.map((e) => {
          const sisa = e.expiresAt
            ? formatDuration(e.expiresAt - Date.now())
            : "Permanent";
          return `${e.id} — ${sisa}`;
        });
        await botList(
          ctx,
          `👑 ${BRANDING.name} PREMIUM LIST`,
          items,
          "No premium users yet.",
        );
        break;
      }

      // ==================================================================
      // VVIP
      // ==================================================================
      case "addvvip": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");

        const { target, duration: durasiRaw } =
          parseRoleTargetAndDuration(args);

        if (!isTelegramUserId(target)) {
          return botError(
            ctx,
            "Usage: /addvvip <user_id>[,<duration>]\nExample: /addvvip 12345,1d or /addvvip 12345 1d\nUse a numeric Telegram user ID. Use 0 or leave the duration empty for permanent access.",
            "⚠️ INVALID FORMAT",
          );
        }

        let durationMs = null;
        if (durasiRaw) {
          const parsed = parseDuration(durasiRaw);
          if (parsed === undefined) {
            return botError(
              ctx,
              "Invalid duration. Use 1d, 12h, 30m, 2w, 1mo, 1y, or 0 for permanent access.",
              "⚠️ INVALID FORMAT",
            );
          }
          durationMs = parsed;
        }

        const entry = addVVIP(target, durationMs, dbScope);
        await botSucces(
          ctx,
          `${target} was added as a VVIP user${isSubBot ? " (this bot only)" : ""}.\nDuration: ${entry.expiresAt ? formatDuration(entry.expiresAt - Date.now()) : "Permanent"}`,
        );
        break;
      }

      case "delvvip": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");
        const target = args[0]?.trim();
        if (!isTelegramUserId(target))
          return botError(ctx, "Usage: /delvvip <user_id>", "⚠️ INVALID FORMAT");
        removeVVIP(target, dbScope);
        await botSucces(ctx, `${target} was removed from VVIP.`);
        break;
      }

      case "listvvip": {
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");
        const vvipUsers = getVVIPs(dbScope);
        const items = vvipUsers.map((e) => {
          const sisa = e.expiresAt
            ? formatDuration(e.expiresAt - Date.now())
            : "Permanent";
          return `${e.id} — ${sisa}`;
        });
        await botList(
          ctx,
          `👑 ${BRANDING.name} VVIP LIST`,
          items,
          "No VVIP users yet.",
        );
        break;
      }

      case "resetvvipcooldown": {
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        const targetId = (args[0] || "").trim() || String(uid);
        resetVVIPSenderUse(targetId);
        await botSucces(
          ctx,
          `VVIP sender cooldown has been reset for ${targetId}.`,
          "✅ COOLDOWN RESET",
        );
        break;
      }

      // ==================================================================
      // ADMIN
      // ==================================================================
      case "addadmin": {
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        const target = args[0]?.trim();
        if (!isTelegramUserId(target))
          return botError(ctx, "Usage: /addadmin <user_id>", "⚠️ INVALID FORMAT");
        addAdmin(target, dbScope);
        await botSucces(
          ctx,
          `${target} was added as an admin${isSubBot ? " (this bot only)" : ""}.`,
        );
        break;
      }

      case "deladmin": {
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        const target = args[0]?.trim();
        if (!isTelegramUserId(target))
          return botError(ctx, "Usage: /deladmin <user_id>", "⚠️ INVALID FORMAT");
        removeAdmin(target, dbScope);
        await botSucces(ctx, `${target} was removed from the admins.`);
        break;
      }

      case "listadmin": {
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        await botList(
          ctx,
          `🛡️ ${BRANDING.name} ADMIN LIST`,
          getAdmins(dbScope),
          "No admins yet.",
        );
        break;
      }

      // ==================================================================
      // MODE
      // ==================================================================
      case "mode": {
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        const target = (args[0] || "").toLowerCase();
        if (!["privat", "private", "public"].includes(target)) {
          return botError(ctx, "Usage: /mode <private/public>", "⚠️ INVALID FORMAT");
        }
        const mode =
          target.startsWith("privat") || target === "private"
            ? "private"
            : "public";
        setMode(mode, dbScope);
        await botSucces(
          ctx,
          `Bot${isSubBot ? " mode" : ""} changed to ${mode}.`,
        );
        break;
      }

      // ==================================================================
      // BROADCAST
      // ==================================================================
      case "bc": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot.",
            "⚠️ NOT AVAILABLE",
          );
        if (!checkAdmin(uid))
          return botError(ctx, "Admins and the owner only.");

        const users = getUsers();
        if (!users.length)
          return botError(ctx, "No users have been recorded yet.", "⚠️ EMPTY");

        const replied = ctx.message.reply_to_message;
        const textArg = args.join(" ");

        if (!replied && !textArg) {
          return botError(
            ctx,
            "/bc <text>, or reply to a message/media and send /bc",
            "⚠️ INVALID FORMAT",
          );
        }

        const wait = await botReply(ctx, "📤 BROADCASTING", [
          ["Progress", `Sending to ${users.length} users...`],
        ]);

        let success = 0;
        let failed = 0;
        let cleaned = 0;

        for (const targetId of users) {
          try {
            if (replied) {
              await ctx.api.copyMessage(
                targetId,
                ctx.chat.id,
                replied.message_id,
              );
            } else {
              await ctx.api.sendMessage(targetId, textArg);
            }
            success++;
          } catch (err) {
            failed++;
            const code = err?.error_code;
            const desc = String(err?.description || err?.message || "");
            if (
              code === 403 ||
              /blocked|chat not found|deactivated|kicked/i.test(desc)
            ) {
              removeUser(targetId);
              cleaned++;
            }
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        await ctx.api
          .deleteMessage(ctx.chat.id, wait.message_id)
          .catch(() => {});
        await botReply(ctx, "✅ BROADCAST SELESAI", [
          ["Total User", users.length],
          ["Successful", `🟢 ${success}`],
          ["Failed", `🔴 ${failed}`],
          ["Users Removed", cleaned],
        ]);
        break;
      }

      // ==================================================================
      // BOT DEPLOY
      // ==================================================================
      case "addbot": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot.",
            "⚠️ NOT AVAILABLE",
          );
        const isOwnerUser = checkOwner(uid);
        const isAdminUser = checkAdmin(uid);
        const isVVIPUser = isVVIP(uid, dbScope);
        const isPremiumUser = isPremium(uid, dbScope);
        const canDeployBot =
          isOwnerUser || isAdminUser || isVVIPUser || isPremiumUser;

        if (!canDeployBot) {
          return botError(
            ctx,
            "Free users can use the main bot only. Bot deployment requires Premium, VVIP, Admin, or Owner access.",
            "⚠️ DEPLOY ACCESS REQUIRED",
          );
        }

        const botLimit =
          isOwnerUser || isAdminUser
            ? Infinity
            : isVVIPUser
              ? 10
              : isPremiumUser
                ? 3
                : 1;
        const currentBotCount = getBotsForUser(uid).length;

        if (Number.isFinite(botLimit) && currentBotCount >= botLimit) {
          return botError(
            ctx,
            isPremiumUser
              ? "Premium users can deploy a maximum of 3 bots."
              : isVVIPUser
                ? "VVIP users can deploy a maximum of 10 bots."
                : "Free users can deploy a maximum of 1 bot.",
            "⚠️ BOT LIMIT REACHED",
          );
        }

        const raw = args.join(" ");
        const [token, ownerId] = raw.split(",").map((s) => s?.trim());

        if (!token || !ownerId) {
          return botError(
            ctx,
            "Usage: /addbot <token>,<owner_id>",
            "⚠️ INVALID FORMAT",
          );
        }

        const { startDeployedBot, describeDeployError } =
          await import("../deploy.js");

        const added = addBotEntry(uid, token, ownerId);
        if (!added)
          return botError(
            ctx,
            "This token is already registered by another deployer.",
          );

        const wait = await botReply(ctx, "⏳ DEPLOYING", [
          ["Status", "Activating the new bot..."],
        ]);

        try {
          await startDeployedBot(token, ownerId, uid);
          await ctx.api
            .deleteMessage(ctx.chat.id, wait.message_id)
            .catch(() => {});
          await botSucces(
            ctx,
            `Bot deployed successfully with owner ID ${ownerId}.\nThis bot has completely separate admin, premium, and mode settings.`,
            "✅ BOT DEPLOYED",
          );
        } catch (err) {
          removeBotEntry(uid, token);
          const notifyOwnerId = String(ownerId || uid || OWNER_ID || "");
          const deployError = describeDeployError(err);

          if (notifyOwnerId) {
            try {
              await bot.api.sendMessage(
                notifyOwnerId,
                `⚠️ Bot deployment failed and was removed automatically.\nToken suffix: ...${token.slice(-6)}\nOwner ID: ${ownerId}\nDeployer: ${uid}\nError: ${deployError}`,
              );
            } catch {}
          }

          await ctx.api
            .deleteMessage(ctx.chat.id, wait.message_id)
            .catch(() => {});
          await botError(ctx, deployError, "❌ DEPLOY FAILED");
        }
        break;
      }

      case "delbot": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot.",
            "⚠️ NOT AVAILABLE",
          );

        const rawToken = args[0];
        if (!rawToken)
          return botError(ctx, "Usage: /delbot <token>", "⚠️ INVALID FORMAT");

        const isOwnerUser = checkOwner(uid);
        const allBots = isOwnerUser
          ? Object.entries(getAllBotsRaw()).flatMap(([deployerUid, bots]) =>
              bots.map((bot) => ({ ...bot, deployerUid })),
            )
          : getBotsForUser(uid).map((bot) => ({ ...bot, deployerUid: uid }));

        const match = allBots.find(
          (bot) => bot.token === rawToken || bot.token.startsWith(rawToken),
        );

        if (!match) {
          return botError(
            ctx,
            isOwnerUser
              ? "This bot token was not found."
              : "This token does not belong to you or was not found.",
          );
        }

        const { stopDeployedBot } = await import("../deploy.js");
        await stopDeployedBot(match.token);
        removeBotEntry(match.deployerUid, match.token);

        await botSucces(ctx, "The bot was stopped and removed successfully.");
        break;
      }

      case "listbot": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot.",
            "⚠️ NOT AVAILABLE",
          );

        const isOwnerUser = checkOwner(uid);
        const myBots = isOwnerUser
          ? Object.entries(getAllBotsRaw()).flatMap(([deployerUid, bots]) =>
              bots.map((bot) => ({ ...bot, deployerUid })),
            )
          : getBotsForUser(uid);
        if (!myBots.length)
          return botError(
            ctx,
            "You have not deployed any bots yet.",
            "⚠️ EMPTY",
          );

        const { deployedBots } = await import("../deploy.js");

        const cells = [
          [
            { text: "Token", is_header: true, align: "center", valign: "middle" },
            {
              text: "Owner ID",
              is_header: true,
              align: "center",
              valign: "middle",
            },
            ...(isOwnerUser
              ? [
                  {
                    text: "Deployed By",
                    is_header: true,
                    align: "center",
                    valign: "middle",
                  },
                ]
              : []),
            {
              text: "Status",
              is_header: true,
              align: "center",
              valign: "middle",
            },
          ],
        ];

        myBots.forEach((b) => {
          const masked = `${b.token.slice(0, 8)}...${b.token.slice(-4)}`;
          const status = deployedBots.has(b.token)
            ? "🟢 Online"
            : "🔴 Offline";
          cells.push([
            { text: masked, align: "left", valign: "middle" },
            { text: b.ownerId, align: "left", valign: "middle" },
            ...(isOwnerUser
              ? [{ text: b.deployerUid, align: "left", valign: "middle" }]
              : []),
            { text: status, align: "left", valign: "middle" },
          ]);
        });

        await sendSXTable(ctx, `🤖 ${BRANDING.name} — MY DEPLOYED BOTS`, cells);
        break;
      }

      // ==================================================================
      // BACKUP / RESTORE DB
      // ==================================================================
      case "backup": {
        if (isSubBot || !checkOwner(uid)) {
          return botError(
            ctx,
            "Database backup is available to the main-bot owner only.",
            "⚠️ NOT AVAILABLE",
          );
        }
        if (ctx.chat.type !== "private") {
          return botError(
            ctx,
            "Run /backup in a private chat so database contents are not exposed.",
          );
        }

        try {
          const backup = createDatabaseBackup();
          const filename = `database-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
          await ctx.api.sendDocument(
            ctx.chat.id,
            new InputFile(
              Buffer.from(JSON.stringify(backup, null, 2)),
              filename,
            ),
            {
              caption: `Database backup: ${Object.keys(backup.files).length} JSON files.`,
            },
          );
        } catch (error) {
          log.error(`Database backup failed: ${error.message}`);
          return botError(
            ctx,
            "Could not create the database backup. Check the server logs.",
            "❌ BACKUP FAILED",
          );
        }
        break;
      }

      case "restore": {
        if (isSubBot || !checkOwner(uid)) {
          return botError(
            ctx,
            "Database restore is available to the main-bot owner only.",
            "⚠️ NOT AVAILABLE",
          );
        }
        if (ctx.chat.type !== "private") {
          return botError(
            ctx,
            "Run /restore in a private chat so database files stay private.",
          );
        }

        pendingDatabaseRestore.set(uid, Date.now());
        await botReply(ctx, "📦 DATABASE RESTORE", [
          [
            "Next step",
            "Send the database backup JSON file in this private chat.",
          ],
          ["Validity", "The upload request expires after 10 minutes."],
          [
            "Safety",
            "A snapshot of the current database is saved before restore.",
          ],
        ]);
        break;
      }

      // ==================================================================
      // PAIRING
      // ==================================================================
      case "pair": {
        if (!checkAccess(uid)) return botError(ctx, "You do not have access.");

        const sessionKey = getSessionKey(uid);
        const notifyTarget = isSubBot ? subBotOwnerId : uid;

        const number = sanitizePhoneDigits(args);
        if (!number)
          return botError(ctx, "Usage: /pair <628xxxxxxxx>", "⚠️ INVALID FORMAT");

        const current = getPairsForUser(sessionKey);
        if (current.includes(number))
          return botError(ctx, "This number is already paired.");
        if (current.length >= MAX_PAIR_PER_USER)
          return botError(
            ctx,
            `Maximum ${MAX_PAIR_PER_USER} numbers allowed.`,
          );

        if (pairingLocks.has(sessionKey)) {
          return botError(
            ctx,
            "Another pairing process is already running for this session. Please wait until it finishes or times out.",
            "⏳ IN PROGRESS",
          );
        }
        pairingLocks.add(sessionKey);

        const deleteMsg = async (msg) => {
          if (!msg?.message_id) return;
          await ctx.api
            .deleteMessage(ctx.chat.id, msg.message_id)
            .catch(() => {});
        };

        let statusMsg = await botReply(ctx, "⏳ PROCESSING", [
          ["Status", "Generating pairing code..."],
        ]);

        (async () => {
          try {
            const sock = await initWhatsappForNumber(
              bot,
              sessionKey,
              number,
              0,
              notifyTarget,
              { forceNew: true },
            );

            await new Promise((r) => setTimeout(r, 3000));
            const code = await sock.requestPairingCode(number);

            await deleteMsg(statusMsg);

            const blocks = [
              { type: "heading", text: "🔐 PAIRING WHATSAPP", size: 1 },
              {
                type: "table",
                cells: [
                  [
                    {
                      text: "This pairing code is valid for 90 seconds. Paste it in WhatsApp > Linked Devices.",
                      is_header: false,
                      align: "center",
                      valign: "middle",
                    },
                  ],
                ],
                is_bordered: true,
                is_striped: true,
              },
              { type: "divider" },
              {
                type: "paragraph",
                text: [{ type: "bold", text: "WhatsApp Number: " }, number],
              },
              {
                type: "paragraph",
                text: [{ type: "bold", text: "Pairing Code: " }, code],
              },
              { type: "divider" },
              {
                type: "buttons",
                buttons: [
                  {
                    text: "Copy Pairing Code",
                    style: "success",
                    copy_text: { text: String(code) },
                  },
                ],
              },
            ];

            try {
              statusMsg = await streamBlocks(ctx, blocks);
            } catch (uiErr) {
              log.error(uiErr);
              statusMsg = await botReply(ctx, "🔐 PAIRING WHATSAPP", [
                ["Number", number],
                ["Pairing Code", code],
                [
                  "Info",
                  "Paste this code in WhatsApp > Linked Devices.",
                ],
              ]);
            }

            const connected = await waitUntilOpen(sessionKey, number, 90000);

            if (!connected) {
              throw new Error("Timeout menunggu koneksi WhatsApp.");
            }

            addPairNumber(sessionKey, number);

            await deleteMsg(statusMsg);
            await botSucces(
              ctx,
              `Number ${number} connected successfully.`,
              "✅ PAIRING SUCCESS",
            );
          } catch (err) {
            log.error(err);
            await endWhatsappForNumber(sessionKey, number).catch(() => {});
            await deleteMsg(statusMsg);
            await botError(
              ctx,
              describeWhatsappError(err),
              "❌ PAIRING FAILED",
            );
          } finally {
            pairingLocks.delete(sessionKey);
          }
        })().catch((err) => {
          log.error(err);
          pairingLocks.delete(sessionKey);
        });

        break;
      }

      case "delpair": {
        if (!checkAccess(uid)) return botError(ctx, "You do not have access.");

        const sessionKey = getSessionKey(uid);
        const number = sanitizePhoneDigits(args);
        if (!number)
          return botError(ctx, "Usage: /delpair <number>", "⚠️ INVALID FORMAT");

        const current = getPairsForUser(sessionKey);
        if (!current.includes(number)) {
          return botError(
            ctx,
            isSubBot
              ? "This number is not paired with this bot."
              : "This number is not paired with your account.",
          );
        }

        await endWhatsappForNumber(sessionKey, number);
        removePairNumber(sessionKey, number);
        await botSucces(ctx, `WhatsApp session ${number} was removed.`);
        break;
      }

      case "listpair": {
        if (!checkAccess(uid)) return botError(ctx, "You do not have access.");

        if (isSubBot) {
          const sessionKey = getSessionKey(uid);
          const numbers = getPairsForUser(sessionKey);
          if (!numbers.length)
            return botError(
              ctx,
              "No numbers are paired with this bot yet.",
              "⚠️ EMPTY",
            );

          const cells = [
            [
              {
                text: "Number",
                is_header: true,
                align: "center",
                valign: "middle",
              },
              {
                text: "Status",
                is_header: true,
                align: "center",
                valign: "middle",
              },
            ],
          ];

          for (const number of numbers) {
            const client = getClient(sessionKey, number);
            cells.push([
              { text: number, align: "left", valign: "middle" },
              {
                text: client?.status === "open" ? "🟢 Online" : "🔴 Offline",
                align: "left",
                valign: "middle",
              },
            ]);
          }

          await sendSXTable(
            ctx,
            "📱 SHARED SESSION — ALL USERS OF THIS BOT",
            cells,
          );
          break;
        }

        const cells = [
          [
            {
              text: "User ID",
              is_header: true,
              align: "center",
              valign: "middle",
            },
            {
              text: "Number",
              is_header: true,
              align: "center",
              valign: "middle",
            },
            {
              text: "Status",
              is_header: true,
              align: "center",
              valign: "middle",
            },
          ],
        ];

        if (checkOwner(uid)) {
          for (const [userId, numbers] of Object.entries(getAllPairs())) {
            for (const number of numbers) {
              const client = getClient(userId, number);
              cells.push([
                { text: userId, align: "left", valign: "middle" },
                { text: number, align: "left", valign: "middle" },
                {
                  text:
                    client?.status === "open" ? "🟢 Online" : "🔴 Offline",
                  align: "left",
                  valign: "middle",
                },
              ]);
            }
          }
        } else {
          const numbers = getPairsForUser(uid);
          if (!numbers.length)
            return botError(ctx, "No numbers are paired yet.", "⚠️ EMPTY");

          for (const number of numbers) {
            const client = getClient(uid, number);
            cells.push([
              { text: uid, align: "left", valign: "middle" },
              { text: number, align: "left", valign: "middle" },
              {
                text: client?.status === "open" ? "🟢 Online" : "🔴 Offline",
                align: "left",
                valign: "middle",
              },
            ]);
          }
        }

        await sendSXTable(ctx, `📱 ${BRANDING.name} PAIR LIST`, cells);
        break;
      }

      case "clearpair": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot.",
            "⚠️ NOT AVAILABLE",
          );
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");
        await clearAllSessions();
        clearAllPairs();
        await botSucces(
          ctx,
          "All WhatsApp sessions for all users have been removed.",
        );
        break;
      }

      // ==================================================================
      // OWNER: ACTING AS SENDER
      // ==================================================================
      case "assender": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot (sub-bot sessions are shared).",
            "⚠️ NOT AVAILABLE",
          );
        if (!checkOwner(uid)) return botError(ctx, "Owner only.");

        const arg = (args[0] || "").trim();

        if (!arg) {
          const current = ownerActingAs.get(String(uid));
          if (!current)
            return botError(
              ctx,
              "You are using your own sender. Usage: /assender <user_id|sub_bot_session|sub_bot_token> or /assender off",
              "ℹ️ STATUS",
            );
          return botSucces(
            ctx,
            `You are using ${describeAssenderTarget(current)}.\nUse /assender off to return to your own sender.`,
            "ℹ️ ACTING AS",
          );
        }

        const target = normalizeAssenderTarget(arg);

        if (target.action === "off") {
          if (!ownerActingAs.has(String(uid)))
            return botError(ctx, "You are already using your own sender.");
          ownerActingAs.delete(String(uid));
          return botSucces(
            ctx,
            "Switched back to your own sender.",
            "✅ RESET",
          );
        }

        if (target.action === "invalid") {
          return botError(
            ctx,
            "Usage: /assender <user_id|sub_bot_session|sub_bot_token> or /assender off",
            "⚠️ INVALID FORMAT",
          );
        }

        const targetKey = target.targetKey;

        if (targetKey === String(uid)) {
          return botError(
            ctx,
            "That is your own user ID; no change is needed.",
          );
        }

        const targetSenders = getPairsForUser(targetKey);
        if (!targetSenders.length) {
          return botError(
            ctx,
            `Target \`${targetKey}\` has no paired senders.`,
            "⚠️ EMPTY",
          );
        }

        ownerActingAs.set(String(uid), targetKey);

        await botSucces(
          ctx,
          `You are now using ${describeAssenderTarget(targetKey)} (${targetSenders.length} number(s)) for all actions.\nUse /assender off to return to your own sender.`,
          "✅ ACTING AS ACTIVE",
        );
        break;
      }

      // ==================================================================
      // VVIP: ACTING AS SENDER
      // ==================================================================
      case "xvvip":
      case "vvipassender": {
        if (isSubBot)
          return botError(
            ctx,
            "This feature is only available on the main bot (sub-bot sessions are shared).",
            "⚠️ NOT AVAILABLE",
          );

        const isPrivilegedVVIPUser =
          checkOwner(uid) || checkAdmin(uid) || isVVIP(uid, dbScope);

        if (getMode(dbScope) === "public" && !isPrivilegedVVIPUser) {
          return botError(
            ctx,
            "This VVIP sender feature is disabled in free/public mode for free users.",
            "⚠️ NOT AVAILABLE",
          );
        }

        if (!isPrivilegedVVIPUser)
          return botError(ctx, "VVIP access is required for this feature.");

        const arg = (args[0] || "").trim();

        if (arg) {
          const target = normalizeAssenderTarget(arg);

          if (target.action === "off") {
            if (!ownerActingAs.has(String(uid)))
              return botError(ctx, "You are already using your own sender.");
            ownerActingAs.delete(String(uid));
            return botSucces(
              ctx,
              "Switched back to your own sender.",
              "✅ RESET",
            );
          }

          if (target.action === "invalid") {
            return botError(
              ctx,
              "Usage: /xvvip or /vvipassender off",
              "⚠️ INVALID FORMAT",
            );
          }

          const targetKey = target.targetKey;
          const currentTarget = getActingTarget(uid);

          if (targetKey === currentTarget) {
            return botError(
              ctx,
              isUsingExternalSender(uid)
                ? `You are already using a VVIP sender from ${describeAssenderTarget(targetKey)}.`
                : "You are already using your own sender session.",
              "⚠️ SESSION ALREADY ACTIVE",
            );
          }

          const targetSenders = getPairsForUser(targetKey);
          if (!targetSenders.length) {
            return botError(
              ctx,
              `Target \`${targetKey}\` has no paired senders.`,
              "⚠️ EMPTY",
            );
          }

          if (!checkOwner(uid)) {
            const usage = consumeVVIPSenderUse(uid);
            if (!usage.allowed) {
              const waitSeconds = Math.ceil(usage.waitMs / 1000);
              const minutes = Math.ceil(waitSeconds / 60);
              return botError(
                ctx,
                `VVIP sender limit reached. Please wait ${minutes} minute(s) before using it again.`,
                "⏳ COOLDOWN",
              );
            }
          }

          ownerActingAs.set(String(uid), targetKey);
          await botSucces(
            ctx,
            `VVIP access enabled: you are now using ${describeAssenderTarget(targetKey)} (${targetSenders.length} number(s)) for all actions.\nUse /xvvip off or /vvipassender off to return to your own sender.`,
            "✅ VVIP ACTING AS ACTIVE",
          );
          break;
        }

        if (isUsingExternalSender(uid)) {
          const activeTarget = getActingTarget(uid);
          return botError(
            ctx,
            `You are already using a VVIP sender from ${describeAssenderTarget(activeTarget)}. Use /xvvip off before selecting another sender.`,
            "⚠️ SESSION ALREADY ACTIVE",
          );
        }

        await sendVVIPSelectorMenu(ctx, {
          checkOwner,
          checkAdmin,
          dbScope,
          botError,
        });
        break;
      }

      // ==================================================================
      // DEFAULT
      // ==================================================================
      default: {
        return;
      }
    }
  });

  // ====================================================================
  // HANDLER: Upload file database backup untuk /restore
  // ====================================================================
  bot.on("message:document", async (ctx) => {
    const uid = String(ctx.from.id);
    const requestTime = pendingDatabaseRestore.get(uid);
    if (!requestTime) return;

    if (isSubBot || !checkOwner(uid) || ctx.chat.type !== "private") {
      pendingDatabaseRestore.delete(uid);
      return botError(
        ctx,
        "Database restore is available in the main bot's private chat to the owner only.",
        "⚠️ NOT AVAILABLE",
      );
    }

    if (Date.now() - requestTime > 10 * 60 * 1000) {
      pendingDatabaseRestore.delete(uid);
      return botError(
        ctx,
        "Restore request expired. Run /restore again.",
        "⌛ EXPIRED",
      );
    }

    const document = ctx.message.document;
    if (!document.file_name?.toLowerCase().endsWith(".json")) {
      return botError(
        ctx,
        "Please upload a .json database backup file.",
        "⚠️ INVALID FILE",
      );
    }
    if (document.file_size && document.file_size > 20 * 1024 * 1024) {
      return botError(
        ctx,
        "Backup file is too large. Maximum size is 20 MB.",
        "⚠️ FILE TOO LARGE",
      );
    }

    try {
      const file = await ctx.getFile();
      if (!file.file_path)
        throw new Error("Telegram did not provide a file path.");
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok)
        throw new Error(`Telegram file download failed (${response.status}).`);

      const rawBackup = await response.text();
      if (Buffer.byteLength(rawBackup, "utf8") > 20 * 1024 * 1024) {
        throw new Error("Backup file is too large. Maximum size is 20 MB.");
      }

      const backup = JSON.parse(rawBackup);
      const result = restoreDatabaseBackup(backup);
      pendingDatabaseRestore.delete(uid);

      const { deployedBots, stopDeployedBot, restoreDeployedBots } =
        await import("../deploy.js");
      for (const token of [...deployedBots.keys()]) {
        await stopDeployedBot(token);
      }
      await restoreDeployedBots(bot);

      await botSucces(
        ctx,
        `Restored ${result.restoredCount} database files. A pre-restore safety copy was saved as ${path.basename(result.safetyCopy)}. WhatsApp session files are stored separately and are not part of this database backup.`,
        "✅ DATABASE RESTORED",
      );
    } catch (error) {
      log.error(
        `Database restore failed for owner ${uid}: ${error.message}`,
      );
      return botError(
        ctx,
        `Restore failed: ${error.message}`,
        "❌ RESTORE FAILED",
      );
    }
  });
}