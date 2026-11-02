import {
  getMode,
  getPairsForUser,
  getAllPairs,
  isVVIP,
  getVVIPs,
} from "../../data/database.js";
import { getClient } from "../whatsapp.js";
import { log } from "../logger.js";
import { describeWhatsappError } from "../whatsapp.js";
import { getTravasEntry } from "../travas.js";
import {
  consumeVVIPSenderUse,
  resetVVIPSenderUse,
} from "../vvipCooldown.js";

export function registerCallbackHandlers(bot, runtime, menu) {
  const {
    isSubBot,
    subBotOwnerId,
    checkOwner,
    checkAdmin,
    checkAccess,
    dbScope,
    describeAssenderTarget,
    ownerActingAs,
    pendingAction,
    pendingTravasTarget,
    sendDoneCard,
    getActingTarget,
    isUsingExternalSender,
  } = runtime;

  const {
    botError,
    botSucces,
    handleMenuCallback,
    sendActionMenu,
    streamBlocks,
  } = menu;

  bot.on("callback_query:data", async (ctx) => {
    const uid = String(ctx.from.id);
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    const handledByMenu = await menu.handleMenuCallback(ctx, data);
    if (handledByMenu) return;

    switch (true) {
      case data === "cancel_execution": {
        pendingTravasTarget.delete(uid);
        await ctx.deleteMessage().catch(() => {});
        await sendActionMenu(ctx);
        return;
      }

      case data.startsWith("travas_pick_"): {
        if (isSubBot) {
          return botError(
            ctx,
            "Sub-bots use manual travas commands. Open /action to view the command list.",
            "⚠️ COMMAND MODE",
          );
        }

        if (!checkAccess(uid)) {
          return botError(
            ctx,
            "You do not have access to travas actions. Premium access is required.",
            "⚠️ ACCESS DENIED",
          );
        }

        const key = data.replace("travas_pick_", "");
        const item = getTravasEntry(key);

        if (!item) {
          return botError(ctx, "This travas option is unavailable.");
        }

        pendingTravasTarget.set(uid, { key, type: item.type, label: item.label });
        await ctx.deleteMessage().catch(() => {});

        const targetGuide = {
          number: {
            title: "WhatsApp Number",
            format: "6281234567890",
            instruction: "Send the target WhatsApp number with country code. Do not include spaces, plus signs, or separators.",
            example: "6281234567890",
          },
          group: {
            title: "WhatsApp Group",
            format: "Invite link or group JID",
            instruction: "Send a WhatsApp group invite link. The bot will resolve it to a real @g.us group JID automatically. You may also send an existing group JID.",
            example: "https://chat.whatsapp.com/ABC123xyz\n1234567890-123456@g.us",
          },
          channel: {
            title: "WhatsApp Channel",
            format: "Channel ID",
            instruction: "Send the channel numeric ID. The bot will convert it to the required WhatsApp newsletter target.",
            example: "1234567890",
          },
        }[item.type];

        const blocks = [
          { type: "heading", text: "🩸 TARGET REQUEST", size: 1 },
          {
            type: "table",
            cells: [
              [
                {
                  text: [
                    {
                      type: "bold",
                      text: "Send one valid target value to continue this travas action.",
                    },
                  ],
                  is_header: true,
                  align: "center",
                  valign: "middle",
                },
              ],
            ],
            is_bordered: false,
            is_striped: false,
          },
          { type: "divider" },
          {
            type: "table",
            cells: [
              [
                {
                  text: "Selected action",
                  is_header: true,
                  align: "left",
                  valign: "middle",
                },
                {
                  text: item.label,
                  is_header: true,
                  align: "left",
                  valign: "middle",
                },
              ],
              [
                {
                  text: "Target type",
                  align: "left",
                  valign: "middle",
                },
                {
                  text: targetGuide.title,
                  align: "left",
                  valign: "middle",
                },
              ],
              [
                {
                  text: "Required format",
                  align: "left",
                  valign: "middle",
                },
                {
                  text: targetGuide.format,
                  align: "left",
                  valign: "middle",
                },
              ],
            ],
            is_bordered: true,
            is_striped: true,
          },
          {
            type: "details",
            summary: ["How to send the target"],
            blocks: [
              {
                type: "table",
                cells: [
                  [
                    {
                      text: targetGuide.instruction,
                      is_header: false,
                      align: "left",
                      valign: "middle",
                    },
                  ],
                  [
                    {
                      text: `Example:\n${targetGuide.example}`,
                      is_header: false,
                      align: "left",
                      valign: "middle",
                    },
                  ],
                ],
                is_bordered: true,
                is_striped: true,
              },
            ],
          },
          { type: "divider" },
          {
            type: "paragraph",
            text: [
              { type: "bold", text: "Important: " },
              "Send only the target value as your next message. The prompt will be removed after a valid target is received.",
            ],
          },
          {
            type: "buttons",
            buttons: [
              {
                text: "Cancel and return to Action Menu",
                style: "danger",
                callback_data: "cancel_execution",
              },
            ],
          },
        ];

        await streamBlocks(ctx, blocks, { footer: false });
        return;
      }

      case data.startsWith("reset_vvip_cooldown_"): {
        const uid = String(ctx.from.id);

        if (!checkOwner(uid)) {
          return botError(ctx, "Owner only.");
        }

        const targetId = data.replace("reset_vvip_cooldown_", "");
        resetVVIPSenderUse(targetId);
        await ctx.deleteMessage().catch(() => {});
        await botSucces(
          ctx,
          `Cooldown for ${targetId} has been reset.`,
          "✅ COOLDOWN RESET",
        );
        return;
      }

      case data.startsWith("vvip_select_"): {
        const uid = String(ctx.from.id);
        const isPrivilegedVVIPUser =
          checkOwner(uid) || checkAdmin(uid) || isVVIP(uid, dbScope);

        if (!isPrivilegedVVIPUser) {
          return botError(ctx, "VVIP access is required for this feature.");
        }

        if (getMode(dbScope) === "public" && !isPrivilegedVVIPUser) {
          return botError(
            ctx,
            "This VVIP sender feature is disabled in free/public mode for free users.",
            "⚠️ NOT AVAILABLE",
          );
        }

        const payload = data.replace("vvip_select_", "");
        const [targetKey, targetNumber] = payload.split("__");

        if (!targetKey || !targetNumber) {
          return botError(ctx, "Invalid VVIP sender selection.");
        }

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

        const targetSenders = getPairsForUser(targetKey);
        if (!targetSenders.includes(targetNumber)) {
          return botError(ctx, "That sender is no longer available.");
        }

        ownerActingAs.set(String(uid), targetKey);
        await ctx.deleteMessage().catch(() => {});
        await botSucces(
          ctx,
          `✅ You are now using ${describeAssenderTarget(targetKey)} and the active sender ${targetNumber}.\nUse /xvvip off or /vvipassender off to return to your own sender.`,
          "✅ VVIP ACTIVE",
        );
        return;
      }

      case data.startsWith("action_"): {
        const uid = String(ctx.from.id);
        const pending = pendingAction.get(uid);

        if (!pending) {
          return botError(ctx, "This action session has expired.");
        }

        const picked = data.replace("action_", "");
        const storageKey = pending.storageKey || uid;

        pendingAction.delete(uid);
        await ctx.deleteMessage().catch(() => {});

        const targets =
          picked === "all" ? getPairsForUser(storageKey) : [picked];

        await sendDoneCard(ctx, {
          command: pending.command,
          target: pending.target,
          type: "all",
          results: targets,
        });

        targets.forEach((number) => {
          const client = getClient(storageKey, number);
          if (client?.sock && client.status === "open") {
            pending.func(client.sock, pending.target).catch((err) => {
              log.error(
                `Eksekusi WhatsApp gagal | ${pending.command} | ${describeWhatsappError(err)}`,
              );
            });
          }
        });

        return;
      }

      default: {
        return;
      }
    }
  });
}
