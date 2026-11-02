import { InlineKeyboard, InputFile } from "grammy";
import {
  isAdmin,
  getPremiumEntry,
  getVVIPEntry,
  getMode,
  getPairsForUser,
  formatDuration,
} from "../data/database.js";
import { getTravasRegistry } from "./travas.js";
import { formatCooldownText } from "./vvipCooldown.js";
import { CUSTOM_EMOJI } from "../config/config.js";

// Menu rendering and callback handling.
export function createMenuModule(bot, deps) {
  const {
    isSubBot,
    OWNER_USERNAME,
    MENU_VIDEO_URL,
    MENU_MEDIA_URL,
    MENU_MEDIA_TYPE,
    BRANDING,
    MENU_PHOTO_URL,
    FORCE_JOIN_CHANNELS,
    checkOwner,
    dbScope,
  } = deps;

  // Shared visual style for all menus.
  function footerBlock(extraNote) {
    const text = [
      { type: "bold", text: `\n` },
      ` \n- ${BRANDING.footer}`,
    ];
    if (extraNote) {
      text.push("\n", { type: "italic", text: extraNote });
    }
    return { type: "footer", text };
  }
  // Render rich-message blocks in a smooth staged sequence.
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildCell(text, options = {}) {
    return {
      text: String(text),
      align: "left",
      valign: "middle",
      ...options,
    };
  }

  function customEmoji(name, text, group = "buttons") {
    const emoji = CUSTOM_EMOJI[group]?.[name];
    if (!emoji?.id) return `${emoji?.fallback || ""}${text}`;

    return [
      {
        type: "custom_emoji",
        custom_emoji_id: emoji.id,
        alternative_text: emoji.fallback || "",
      },
      text,
    ];
  }

  function buildTable(headers, rows, cellStyle = {}) {
    const headerCells = headers.map((text) =>
      buildCell(text, {
        is_header: true,
        align: "center",
        valign: "middle",
      }),
    );

    const rowCells = rows.map((row) =>
      row.map((value) =>
        buildCell(value, {
          align: cellStyle.align || "left",
          valign: cellStyle.valign || "middle",
        }),
      ),
    );

    return {
      cells: [headerCells, ...rowCells],
      type: "table",
      is_bordered: true,
      is_striped: true,
    };
  }

  function buildButtonBlock(buttons) {
    return {
      type: "buttons",
      buttons: buttons.map((button) => ({
        text: button.text,
        style: button.style || "danger",
        callback_data: button.callback_data,
      })),
    };
  }

  function getOwnerUrl() {
    const ownerUsername = String(OWNER_USERNAME || "telegram").replace(/^@/, "");
    return `https://t.me/${ownerUsername}`;
  }

  function buildMenuMediaBlock() {
    const mediaType = (MENU_MEDIA_TYPE || "video").toLowerCase();
    const mediaUrl = MENU_MEDIA_URL || (mediaType === "photo" ? MENU_PHOTO_URL : MENU_VIDEO_URL);

    if (!mediaUrl) return null;

    const mediaKey = mediaType === "photo" ? "photo" : "video";
    return {
      type: mediaKey,
      [mediaKey]: {
        type: mediaKey,
        media: mediaUrl,
      },
    };
  }

  async function streamBlocks(ctx, rawBlocks, options = {}) {
    const {
      reply_markup,
      totalDurationMs = 1000,
      maxSteps = 1,
      footerNote,
      footer = true,
    } = options;

    const blocks = footer ? [...rawBlocks, footerBlock(footerNote)] : rawBlocks;

    // Draft cuma bisa dipakai di private chat (chat_id harus Integer).
    const isPrivateChat = ctx.chat?.type === "private";

    if (isPrivateChat && blocks.length > 1) {
      const draftId = Date.now();

      // Step 0: placeholder kecil biar kerasa "loading" dulu sebelum konten muncul.
      await bot.api.raw
        .sendRichMessageDraft({
          chat_id: ctx.chat.id,
          draft_id: draftId,
          rich_message: {
            blocks: [{ type: "paragraph", text: "🕸 Prepare menu..." }],
          },
        })
        .catch(() => { });
      await sleep(600);

      const steps = Math.min(maxSteps, blocks.length);
      const chunkSize = Math.max(1, Math.ceil(blocks.length / steps));
      const stepDelay = Math.floor(totalDurationMs / steps);

      for (let i = chunkSize; i < blocks.length; i += chunkSize) {
        await bot.api.raw
          .sendRichMessageDraft({
            chat_id: ctx.chat.id,
            draft_id: draftId,
            rich_message: { blocks: blocks.slice(0, i) },
          })
          .catch(() => { });
        await sleep(stepDelay);
      }
    }

    // Finalize — ini yang beneran nempel permanen di chat.
    return bot.api.raw.sendRichMessage({
      chat_id: ctx.chat.id,
      rich_message: { blocks },
      ...(reply_markup ? { reply_markup } : {}),
    });
  }

  // Shared table helper used by all status/result messages.
  function rowsToCells(rows) {
    return [
      [
        { text: "Status", is_header: true, align: "center", valign: "middle" },
        { text: "Detail", is_header: true, align: "center", valign: "middle" },
      ],
      ...rows.map(([label, value]) => [
        { text: String(label), align: "left", valign: "middle" },
        { text: String(value), align: "left", valign: "middle" },
      ]),
    ];
  }
  async function sendTableMessage(ctx, title, cells, options = {}) {
    const blocks = [
      { type: "heading", text: title, size: 1 },
      { type: "table", cells, is_bordered: true, is_striped: true },
    ];

    if (options.stream) {
      return streamBlocks(ctx, blocks, {
        reply_markup: options.keyboard,
        totalDurationMs: options.totalDurationMs ?? 2000,
        maxSteps: options.maxSteps ?? 2,
        footerNote: options.footerNote,
        footer: options.footer,
      });
    }
    return bot.api.raw.sendRichMessage({
      chat_id: ctx.chat.id,
      rich_message: { blocks },
      ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    });
  }

  // Notifikasi umum (dipakai buat error/success/processing di seluruh bot).
  function botReply(ctx, title, rows, keyboard = null) {
    return sendTableMessage(ctx, title, rowsToCells(rows), { keyboard });
  }

  function botError(ctx, reason, title = "⚠️ ACCESS WARNING\n") {
    return botReply(ctx, title, [
      ["Access", "❌ Denied"],
      ["Reason", reason],
    ]);
  }

  function botSucces(ctx, detail, title = "🟢 STATUS SUCCESS\n") {
    return botReply(ctx, title, [
      ["Status", "✅ Successful"],
      ["Detail", detail],
    ]);
  }

  function botList(ctx, title, items, emptyText = "Empty") {
    if (!items.length) return botReply(ctx, title, [["Total", emptyText]]);
    return botReply(
      ctx,
      title,
      items.map((item, i) => [`#${i + 1}`, item]),
    );
  }

  async function sendTextResult(ctx, data) {
    if (data.type === "single") {
      return botReply(ctx, "🟢 Status Results\n", [
        ["Message", "✅ Sent successfully"],
        ["Session", data.session],
        ["Target", data.target],
      ]);
    }

    if (data.type === "all") {
      const rows = data.results.map((item) => {
        const split = item.split(" — ");
        return [split[0], split[1] || "-"];
      });
      return botReply(ctx, "🟢 Status Results", rows);
    }
  }

  // ----------------------------- ( FORCE JOIN: CEK SEMUA CHANNEL DI ENV ) ----------------------------- \\
  /* Support banyak channel sekaligus (FORCE_JOIN_CHANNEL=@a,@b,@c di .env).
       User wajib join SEMUA channel yang terdaftar. */

  async function isUserJoinedChannel(uid) {
    if (!FORCE_JOIN_CHANNELS || !FORCE_JOIN_CHANNELS.length) return true;

    for (const channel of FORCE_JOIN_CHANNELS) {
      try {
        const member = await bot.api.getChatMember(channel, uid);
        if (!["member", "administrator", "creator"].includes(member.status)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  function joinChannelKeyboard() {
    const kb = new InlineKeyboard();
    for (const channel of FORCE_JOIN_CHANNELS) {
      kb.url(
        `📢 Join ${channel}`,
        `https://t.me/${String(channel).replace("@", "")}`,
      ).row();
    }
    kb.text("✅ I Have Joined", "recheck_join");
    return kb;
  }

  async function sendJoinRequiredMenu(ctx, reason = "You must join the required channel first.") {
    const channelButtons = FORCE_JOIN_CHANNELS.map((channel) => ({
      text: `📢 Join ${channel}`,
      style: "success",
      url: `https://t.me/${String(channel).replace("@", "")}`,
    }));

    const mediaBlock = buildMenuMediaBlock();
    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: `Access Required ── ${ctx.from.first_name}`,
        size: 2,
      },
      {
        type: "table",
        cells: [
          [
            {
              text: "You must join the required channel before using this bot.",
              is_header: true,
              align: "center",
              valign: "middle",
            },
          ],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "table",
        cells: [
          [
            { text: "Status", is_header: true, align: "center", valign: "middle" },
            { text: "Details", is_header: true, align: "center", valign: "middle" },
          ],
          [{ text: "Access", align: "left", valign: "middle" }, { text: "❌ Locked", align: "left", valign: "middle" }],
          [{ text: "Reason", align: "left", valign: "middle" }, { text: reason, align: "left", valign: "middle" }],
          [{ text: "Action", align: "left", valign: "middle" }, { text: "Join all required channels", align: "left", valign: "middle" }],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "buttons",
        buttons: channelButtons,
      },
      {
        type: "buttons",
        buttons: [
          {
            text: "✅ I Have Joined",
            style: "success",
            callback_data: "recheck_join",
          },
        ],
      },
    ];

    return streamBlocks(ctx, blocks);
  }

  // ----------------------------- ( HELPER: SEND SX TABLE ) ----------------------------- \\
  /* Mengirim tabel generik (dipakai listpair, listbot, dll). */

  async function sendSXTable(ctx, title, cells) {
    return sendTableMessage(ctx, title, cells, {
      stream: true,
      totalDurationMs: 2000,
      maxSteps: 2,
    });
  }

  // ----------------------------- ( MENU: SEND START MENU ) ----------------------------- \\
  /* Menampilkan menu utama bot. */

  async function sendStartMenu(ctx) {
    const ownerUsername = String(OWNER_USERNAME || "telegram").replace(
      /^@/,
      "",
    );
    const ownerUrl = `https://t.me/${ownerUsername}`;

    const mediaBlock = buildMenuMediaBlock();
    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: `Hello ── ${ctx.from.first_name} ⋆𐙚`,
        size: 2,
      },
      {
        type: "table",
        cells: [
          [
            {
              text: [
                { type: "bold", text: "This bot is a multi-session WhatsApp bot  that allows you to manage multiple WhatsApp accounts from a single interface." },
              ],
              is_header: true,
              align: "center",
              valign: "middle",
            }
          ]
        ],
        is_bordered: false,
        is_striped: false,
      },

      {
        type: "table",
        cells: [
          [
            {
              text: "𝖨𝗇𝖿𝗈𝗋𝗆𝖺𝗍𝗂𝗈𝗇",
              is_header: true,
              align: "center",
              valign: "middle",
            },
            {
              text: "𝖣𝖾𝗍𝖺𝗂𝗅𝗌",
              is_header: true,
              align: "center",
              valign: "middle",
            },
          ],
          [{ text: "𝖢𝗋𝖾𝖺𝗍𝗈𝗋" }, { text: BRANDING.creator }],
          [{ text: "𝖵𝖾𝗋𝗌𝗂𝗈𝗇" }, { text: BRANDING.version }],
          [
            { text: "𝖳𝗂𝗉𝖾" },
            { text: isSubBot ? "Sub-Bot (Clone)" : "Main Bot" },
          ],
          [
            { text: "Mode Bot" },
            {
              text: !isSubBot
                ? getMode() === "public"
                  ? "Public"
                  : "Private"
                : "—",
            },
          ],
          [{ text: "𝖲𝗍𝖺𝗍𝗎𝗌" }, { text: customEmoji("status", " Online", "startMenu") }],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("learn", " Learn Features"),
            style: "success",
            callback_data: "learn_features_menu",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {

            text: customEmoji("all", " 𝖺𝗅𝗅 - 𝗆𝖾𝗇𝗎"),
            style: "danger",
            callback_data: "all_menu",
          },
          {
            text: customEmoji("action", " 𝖺𝖼𝗍𝗂𝗈𝗇 - 𝗆𝖾𝗇𝗎"),
            style: "danger",
            callback_data: "action_menu",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("info", " 𝗆𝗒 - 𝗂𝗇𝖿𝗈"),
            style: "success",
            callback_data: "my_info_menu",
          }
        ]
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("contact", " 𝖼𝗈𝗇𝗍𝖺𝖼𝗍 - 𝗈𝗐𝗇𝖾𝗋"),
            style: "success",
            url: ownerUrl,
          }
        ]
      },
    ];
    await streamBlocks(ctx, blocks);
  }

  // ----------------------------- ( MENU: SEND ACTION MENU ) ----------------------------- \\
  /* Menampilkan menu khusus action dengan daftar command, info, risiko. */

  async function sendActionMenu(ctx) {
    const ownerUrl = getOwnerUrl();
    const registry = getTravasRegistry();

    if (isSubBot) {
      const commandCategories = [
        { type: "number", key: "android", label: "Android", exclude: "ios" },
        { type: "number", key: "ios", label: "iPhone", only: "ios" },
        { type: "group", key: "group", label: "Group" },
        { type: "channel", key: "channel", label: "Channel" },
      ];

      const commandDetails = commandCategories.flatMap((category) => {
        const items = registry.filter((item) => {
          if (category.only) return item.key === category.only;
          if (category.exclude) return item.type === category.type && item.key !== category.exclude;
          return item.type === category.type;
        });
        const rows = items
          .map((item) => [
            `/${item.command || item.key} <${item.type === "number" ? "number" : item.type === "group" ? "group" : "channel_id"}>`,
            item.label,
          ]);

        if (!rows.length) return [];

        return [
          { type: "divider" },
          {
            type: "table",
            cells: [[{ text: [{ type: "bold", text: ` ${category.label}` }], is_header: true, align: "center", valign: "middle" }]],
            is_bordered: false,
            is_striped: false,
          },
          buildTable(["Command", "Action"], rows),
        ];
      });

      const mediaBlock = buildMenuMediaBlock();

      const blocks = [
        {
          type: "heading",
          text: `${BRANDING.emoji} ${BRANDING.shortName}`,
          size: 1,
        },
        ...(mediaBlock ? [mediaBlock] : []),
        {
          type: "heading",
          text: customEmoji("title", " Action Center ── Menu", "actionMenu"),
          size: 2,
        },
        {
          type: "paragraph",
          text: "Use the travas command below and replace the target value with the destination you want to use.",
        },
        {
          type: "details",
          summary: customEmoji("available", " Available Travas", "actionMenu"),
          blocks: commandDetails,
        },
        { type: "paragraph", text: "\n" },
        {
          type: "buttons",
          buttons: [
            {
              text: customEmoji("back", " back menu"),
              style: "danger",
              callback_data: "back_menu",
            },
          ],
        },
        {
          type: "buttons",
          buttons: [
            {
              text: customEmoji("contact", " 𝖼𝗈𝗇𝗍𝖺𝖼𝗍 - 𝗈𝗐𝗇𝖾𝗋"),
              style: "success",
              url: ownerUrl,
            }
          ]
        },
      ];

      await streamBlocks(ctx, blocks);
      return;
    }

    const categoryMap = {
      android: registry.filter((item) => item.type === "number" && !["ios"].includes(item.key),
      ),
      ios: registry.filter((item) => item.key === "ios"),
      group: registry.filter((item) => item.type === "group"),
      channel: registry.filter((item) => item.type === "channel"),
    };

    const categoryOrder = [
      { key: "android", label: "Android", style: "danger" },
      { key: "ios", label: "iPhone", style: "success" },
      { key: "group", label: "Group", style: "danger" },
      { key: "channel", label: "Channel", style: "success" },
    ];

    const buildButtonRows = (items, perRow = 2) => {
      const rows = [];
      for (let i = 0; i < items.length; i += perRow) {
        rows.push(
          items.slice(i, i + perRow).map((item) => ({
            text: item.label,
            style: item.type === "group" ? "danger" : item.type === "channel" ? "success" : "danger",
            callback_data: `travas_pick_${item.key}`,
          })),
        );
      }
      return rows.map((row) => ({ type: "buttons", buttons: row }));
    };

    const groupedDetails = categoryOrder
      .filter(({ key }) => categoryMap[key]?.length)
      .flatMap(({ key, label }) => [
        { type: "divider" },
        {
          type: "table",
          cells: [[{ text: [{ type: "bold", text: ` ${label}` }], is_header: true, align: "center", valign: "middle" }]],
          is_bordered: false,
          is_striped: false,
        },
        ...buildButtonRows(categoryMap[key], 2),
      ]);

    const commandRows = registry.map((item) => [
      `/${item.command || item.key}`,
      item.label,
      item.type,
    ]);



    const mediaBlock = buildMenuMediaBlock();
    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: customEmoji("title", " Action Center ── Menu", "actionMenu"),
        size: 2,
      },
      {
        type: "paragraph",
        text: "Click a travas action below. The bot will ask for the target and then send it automatically.",
      },
      {
        type: "details",
        summary: customEmoji("buttons", " Buttons Travas", "actionMenu"),
        blocks: groupedDetails,
      },
      {
        type: "details",
        summary: customEmoji("listcommands", " Command Travas", "actionMenu"),
        blocks: [
          buildTable(["Command", "Action", "Type"], commandRows),
        ],
      },
      { type: 'paragraph', text: '\n' },
      {
        type: "buttons",
        buttons: [
          {
            text: "⁉️ back menu",
            style: "danger",
            callback_data: "back_menu",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("contact", " 𝖼𝗈𝗇𝗍𝖺𝖼𝗍 - 𝗈𝗐𝗇𝖾𝗋"),
            style: "success",
            url: ownerUrl,
          }
        ]
      },
    ];

    await streamBlocks(ctx, blocks);
  }

  // ----------------------------- ( MENU: SEND ALL MENU ) ----------------------------- \\
  /* Menampilkan semua command yang tersedia. */

  async function sendAllMenu(ctx) {
    const divider = { type: "divider" };
    const ownerUrl = getOwnerUrl();

    const systemCommands = [
      ["/mode", "Bot mode", "Owner"],
      ["/start", "Main menu", "All"],
      ["/menu", "All commands", "All"],
      ["/myinfo", "Your account information", "All"],
    ];

    if (!isSubBot) {
      systemCommands.push(
        ["/backup", "Download a full database backup", "Owner"],
        ["/restore", "Restore database from a JSON backup", "Owner"],
      );
    }

    const menuGroup = [
      {
        title: "System - Menu",
        data: systemCommands,
      },
      {
        title: "Pairing - Menu",
        data: [
          ["/pair", "Pair WhatsApp", "Premium"],
          ["/delpair", "Delete session", "Premium"],
          ["/listpair", "List sender", "User"],
          ["/clearpair", "Clear all sessions", "Owner"],
        ],
      },
      {
        title: "Travas - Menu",
        data: [
          ["/vxcrash", "FCNEW album/status payload", "Premium"],
          ["/vxdelay", "Delay-X2 message stream", "Premium"],
          ["/freeze", "Freeze / crash payload", "Premium"],
          ["/ui", "Interactive UI flood", "Premium"],
          ["/ios", "iOS rich-message payload", "Premium"],
          ["/crashgb", "Group crash payload", "Premium"],
          ["/bangb", "Group ban participant loop", "Premium"],
          ["/channel", "Channel crash payload", "Premium"],
        ],
      },
      {
        title: "Premium - Menu",
        data: [
          ["/addprem", "Add premium (ID[,duration])", "Admin"],
          ["/delprem", "Remove premium", "Admin"],
          ["/listprem", "List premium", "Admin"],
        ],
      },
      {
        title: "VVIP - Menu",
        data: [
          ["/addvvip", "Add VVIP (ID[,duration])", "Admin"],
          ["/delvvip", "Remove VVIP", "Admin"],
          ["/listvvip", "List VVIP", "Admin"],
          ["/xvvip", "Use active VVIP sender", "VVIP"],
        ],
      },
      {
        title: "Admin - Menu",
        data: [
          ["/addadmin", "Add admin", "Owner"],
          ["/deladmin", "Remove admin", "Owner"],
          ["/listadmin", "List admin", "Owner"],
        ],
      },
    ];

    if (!isSubBot) {
      menuGroup.splice(1, 0, {
        title: "Deploy - Menu",
        data: [
          ["/addbot", "Deploy bot baru", "Premium"],
          ["/delbot", "Remove bot", "Premium"],
          ["/listbot", "List bot milikku", "Premium"],
          ["/bc", "Broadcast", "Admin"],
        ],
      });
    }

    const mediaBlock = buildMenuMediaBlock();
    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: customEmoji("title", " Command Library ── Menu", "allMenu"),
        size: 2,
      },
      {
        type: "table",
        cells: [
          [
            { text: "This is the command library menu. Click the menu below to see the list of commands available in this bot.", is_header: true, align: "center", valign: "middle" },
          ],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "table",
        cells: [
          [
            { text: "Category", is_header: true, align: "center", valign: "middle" },
            { text: "Count", is_header: true, align: "center", valign: "middle" },
          ],
          [{ text: "System", align: "left", valign: "middle" }, { text: isSubBot ? "4" : "6", align: "center", valign: "middle" }],
          [{ text: "Pairing", align: "left", valign: "middle" }, { text: "4", align: "center", valign: "middle" }],
          [{ text: "Travas", align: "left", valign: "middle" }, { text: "8", align: "center", valign: "middle" }],
          [{ text: "Premium", align: "left", valign: "middle" }, { text: "3", align: "center", valign: "middle" }],
          [{ text: "Admin", align: "left", valign: "middle" }, { text: "3", align: "center", valign: "middle" }],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "details",
        summary: customEmoji("details", " 𝗖𝗹𝗶𝗰𝗸 𝗛𝗲𝗿𝗲 ", "allMenu"),
        blocks: menuGroup.map((group) => ({
          type: "details",
          summary: [group.title],
          blocks: [
            buildTable(["Command", "Info", "Access"], group.data),
          ],
        })),
      },
      {
        type: "table",
        cells: [
          [{ text: "Click the menu above to see the command list", is_header: false, align: "center", valign: "middle" }],
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("back", " back menu"),
            style: "danger",
            callback_data: "back_menu",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("contact", " 𝖼𝗈𝗇𝗍𝖺𝖼𝗍 - 𝗈𝗐𝗇𝖾𝗋"),
            style: "success",
            url: ownerUrl,
          }
        ]
      },];

    await streamBlocks(ctx, blocks);
  }

  function getLearnFeaturesContent(language = "id") {
    const normalized = (language || "id").toLowerCase();
    const map = {
      id: {
        title: "Belajar Fitur Bot",
        intro: "Bot ini membantu mengelola sender WhatsApp, role pengguna, fitur premium/VVIP, menu akses, dan kontrol bot secara cepat dan terstruktur.",
        rows: [
          ["Main Bot", "Bot utama yang mengatur semua sender WA, menu, dan akses pengguna."],
          ["Mode Bot", "Public = semua user bisa melihat fitur umum. Private = mode tertutup untuk akses tertentu."],
          ["Pairing", "Gunakan /pair untuk menambah sender, /listpair untuk cek sender aktif, /delpair untuk hapus sender, /clearpair untuk reset semua."],
          ["Premium", "User premium mendapat akses lebih luas, termasuk fitur pairing dan action yang lebih tinggi."],
          ["VVIP", "User VVIP bisa memakai sender aktif dengan cooldown 15 menit dan batas 5 kali pemakaian dalam jangka waktu tertentu."],
          ["Admin / Owner", "Admin dan owner dapat mengatur role, list user, mode bot, backup, dan pengaturan utama bot."],
          ["My Info", "Lihat role, status premium/VVIP, sisa durasi, cooldown, dan jumlah sender aktif."],
          ["Cara Pakai", "Mulai dari /start, buka /menu, cek /myinfo, lalu gunakan /pair atau /xvvip sesuai role dan akses."],
        ],
      },
      en: {
        title: "Learn Bot Features",
        intro: "This bot manages WhatsApp senders, user roles, premium/VVIP access, command access, and bot controls in one central system.",
        rows: [
          ["Main Bot", "Main bot that manages all WhatsApp senders, menus, and user access."],
          ["Bot Mode", "Public = general features are visible to all users. Private = access is restricted to selected roles."],
          ["Pairing", "Use /pair to add a sender, /listpair to view active senders, /delpair to remove one, and /clearpair to reset all sessions."],
          ["Premium", "Premium users receive broader access to pairing and action features."],
          ["VVIP", "VVIP users can use active senders with a 15-minute cooldown and a limit of 5 uses within that window."],
          ["Admin / Owner", "Admins and owners can manage roles, bot mode, user lists, backups, and core bot settings."],
          ["My Info", "Check your role, premium/VVIP status, remaining time, cooldown, and active sender count."],
          ["How to Use", "Start with /start, open /menu, check /myinfo, then use /pair or /xvvip depending on your access level."],
        ],
      },
      ar: {
        title: "تعرف على ميزات البوت",
        intro: "يدير هذا البوت مراسلي واتساب، أدوار المستخدمين، صلاحيات premium/VVIP، قوائم الوصول، والتحكم في البوت من نقطة واحدة.",
        rows: [
          ["البوت الرئيسي", "البوت الأساسي الذي يدير جميع مرسلي واتساب والقوائم والوصول."],
          ["وضع البوت", "Public = الميزات العامة ظاهرة لكل المستخدمين. Private = الوصول مقيد للأدوار المحددة."],
          ["الإقران", "استخدم /pair لإضافة مرسل، /listpair لمراجعة المرسلين النشطين، /delpair لحذف واحد، و /clearpair لإعادة تعيين جميع الجلسات."],
          ["Premium", "يتمتع المستخدمون المميزون بوصول أوسع إلى ميزات الإقران والعمل."],
          ["VVIP", "يمكن لمستخدمي VVIP استخدام المرسلين النشطين مع فترة تبريد 15 دقيقة وحد أقصى 5 استخدامات خلال تلك الفترة."],
          ["المشرف / المالك", "يمكن للمشرفين والمالكين إدارة الأدوار، وضع البوت، قوائم المستخدمين، النسخ الاحتياطية، وإعدادات البوت الأساسية."],
          ["معلوماتي", "راجع دورك، حالة Premium/VVIP، الوقت المتبقي، فترة التبريد، وعدد المرسلين النشطين."],
          ["طريقة الاستخدام", "ابدأ بـ /start، افتح /menu، تحقق من /myinfo، ثم استخدم /pair أو /xvvip حسب مستوى الوصول الخاص بك."],
        ],
      },
      pt: {
        title: "Aprenda os Recursos do Bot",
        intro: "Este bot gerencia remetentes do WhatsApp, papéis de usuário, acesso premium/VVIP, menus e controle central do bot.",
        rows: [
          ["Bot Principal", "Bot principal que gerencia todos os remetentes do WhatsApp, menus e acesso de usuários."],
          ["Modo do Bot", "Public = recursos gerais ficam visíveis para todos. Private = acesso restrito a funções específicas."],
          ["Emparelhamento", "Use /pair para adicionar um remetente, /listpair para ver os ativos, /delpair para remover um, e /clearpair para resetar todas as sessões."],
          ["Premium", "Usuários premium recebem acesso mais amplo a recursos de pairing e ações."],
          ["VVIP", "Usuários VVIP podem usar remetentes ativos com cooldown de 15 minutos e limite de 5 usos no período."],
          ["Admin / Dono", "Admins e donos podem gerenciar papéis, modo do bot, lista de usuários, backups e configurações principais."],
          ["Minha Info", "Veja seu papel, status premium/VVIP, tempo restante, cooldown e quantidade de remetentes ativos."],
          ["Como Usar", "Comece com /start, abra /menu, veja /myinfo e depois use /pair ou /xvvip conforme seu nível de acesso."],
        ],
      },
    };

    return map[normalized] || map.id;
  }

  async function sendLearnFeaturesMenu(ctx, language = "id") {
    const locale = getLearnFeaturesContent(language);
    const mediaBlock = buildMenuMediaBlock();

    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: customEmoji("title", ` ${locale.title}`, "learnMenu"),
        size: 2,
      },
      {
        type: "table",
        cells: [
          [
            {
              text: locale.intro,
              is_header: true,
              align: "center",
              valign: "middle",
            },
          ],
        ],
        is_bordered: true,
        is_striped: true,
      },
      {
        type: "buttons",
        buttons: [
          { text: "🇮🇩 Indonesia", style: "success", callback_data: "learn_lang_id" },
          { text: "🇬🇧 English", style: "success", callback_data: "learn_lang_en" },
          { text: "🇸🇦 العربية", style: "success", callback_data: "learn_lang_ar" },
          { text: "🇵🇹 Português", style: "success", callback_data: "learn_lang_pt" },
        ],
      },
      {
        type: "details",
        summary: customEmoji("details", " Learn Features", "learnMenu"),
        blocks: [
          {
            type: "table",
            cells: [
              [
                { text: "Feature", is_header: true, align: "center", valign: "middle" },
                { text: "Explanation", is_header: true, align: "center", valign: "middle" },
              ],
              ...locale.rows.map(([title, desc]) => [
                { text: String(title), align: "left", valign: "middle" },
                { text: String(desc), align: "left", valign: "middle" },
              ]),
            ],
            is_bordered: true,
            is_striped: true,
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("back", " back menu"),
            style: "danger",
            callback_data: "back_menu",
          },
        ],
      },
    ];

    await streamBlocks(ctx, blocks);
  }

  // ----------------------------- ( MENU: MY INFO ) ----------------------------- \\

  async function sendMyInfoMenu(ctx) {
    const uid = String(ctx.from.id);
    const ownerUrl = getOwnerUrl();
    const owner = checkOwner(uid);
    const admin = !owner && isAdmin(uid, dbScope);
    const premiumEntry = getPremiumEntry(uid, dbScope);
    const vvipEntry = getVVIPEntry(uid, dbScope);

    let status = "Free User";
    if (owner) status = "Owner";
    else if (admin) status = "Admin";
    else if (vvipEntry) status = "VVIP";
    else if (premiumEntry) status = "Premium";

    let sisaDurasi = "-";
    if (vvipEntry) {
      sisaDurasi = vvipEntry.expiresAt
        ? formatDuration(vvipEntry.expiresAt - Date.now())
        : "Permanent";
    } else if (premiumEntry) {
      sisaDurasi = premiumEntry.expiresAt
        ? formatDuration(premiumEntry.expiresAt - Date.now())
        : "Permanent";
    }

    const sessionKey = uid;
    const totalPair = isSubBot ? "-" : getPairsForUser(sessionKey).length;
    const cooldownText = formatCooldownText(uid);
    const fullName =
      ctx.from.first_name +
      (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
    const username = ctx.from.username
      ? `@${ctx.from.username}`
      : "No username";
    const languageCode = ctx.from.language_code
      ? ctx.from.language_code.toUpperCase()
      : "-";
    const isPremiumTelegram = ctx.from.is_premium ? "Yes" : "No";

    const divider = { type: "divider" };

    const makeDetails = (emojiKey, title, headers, dataRows) => ({
      type: "details",
      summary: customEmoji(emojiKey, ` ${title}`, "myInfo"),
      blocks: [buildTable(headers, dataRows)],
    });

    const mediaBlock = buildMenuMediaBlock();
    const blocks = [
      {
        type: "heading",
        text: `${BRANDING.emoji} ${BRANDING.shortName}`,
        size: 1,
      },
      ...(mediaBlock ? [mediaBlock] : []),
      {
        type: "heading",
        text: customEmoji("account", " Account Info ── Menu", "myInfo"),
        size: 2,
      },
      {
        type: "table",
        cells: [
          [
            {
              text: [
                {
                  type: "bold",
                  text: "This is your account information menu. Click the sections below to see your Telegram account details and bot status.",
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
      divider,
      {
        type: "table",
        cells: [
          [
            { text: "Status", is_header: true, align: "center", valign: "middle" },
            { text: "Value", is_header: true, align: "center", valign: "middle" },
          ],
          [{ text: "Role", align: "left", valign: "middle" }, { text: status, align: "left", valign: "middle" }],
          [{ text: "VVIP", align: "left", valign: "middle" }, { text: vvipEntry ? "Active" : "Inactive", align: "left", valign: "middle" }],
          [{ text: "Premium", align: "left", valign: "middle" }, { text: premiumEntry ? "Active" : "Inactive", align: "left", valign: "middle" }],
          [{ text: "Balance", align: "left", valign: "middle" }, { text: sisaDurasi, align: "left", valign: "middle" }],
          [{ text: "VVIP Cooldown", align: "left", valign: "middle" }, { text: cooldownText, align: "left", valign: "middle" }],
        ],
        is_bordered: true,
        is_striped: true,
      },
      divider,
      makeDetails(
        "account",
        "Telegram Account",
        ["Info", "Detail"],
        [
          ["Full Name", fullName],
          ["Username", username],
          ["Telegram ID", uid],
          ["Language", languageCode],
          ["Telegram Premium", isPremiumTelegram],
        ],
      ),
      divider,
      makeDetails(
        "botStatus",
        "Bot Status",
        ["Info", "Detail"],
        [
          ["Status", status],
          ["Bot VVIP", vvipEntry ? "Active" : "Inactive"],
          ["Bot Premium", premiumEntry ? "Active" : "Inactive"],
          ["Remaining Time", sisaDurasi],
        ],
      ),
      ...(!isSubBot
        ? [
          divider,
          makeDetails(
            "statistics",
            "Bot Statistics",
            ["Info", "Detail"],
            [
              ["Total WhatsApp Pairs", String(totalPair)],
              [
                "Mode Bot",
                getMode() === "public" ? "Public" : "Private",
              ],
            ],
          ),
        ]
        : []),
      divider,
      {
        type: "table",
        cells: [
          [{ text: `Note: The data above was automatically retrieved from your Telegram profile by ${BRANDING.name}.`, is_header: false, align: "center", valign: "middle" }],
        ],
      },
      {
        type: "table",
        cells: [
          [{ text: "Click the menu above to see the command list", is_header: false, align: "center", valign: "middle" }],
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("back", " back menu"),
            style: "danger",
            callback_data: "back_menu",
          },
        ],
      },
      {
        type: "buttons",
        buttons: [
          {
            text: customEmoji("contact", " 𝖼𝗈𝗇𝗍𝖺𝖼𝗍 - 𝗈𝗐𝗇𝖾𝗋"),
            style: "success",
            url: ownerUrl,
          }
        ]
      },
    ];

    await streamBlocks(ctx, blocks);
  }

  // ----------------------------- ( CALLBACK: HANDLE MENU-RELATED BUTTONS ) ----------------------------- \\
  /* Return true when this menu handled the callback. */

  async function handleMenuCallback(ctx, data) {
    if (data === "recheck_join") {
      const uidCheck = String(ctx.from.id);
      const joined = await isUserJoinedChannel(uidCheck);
      if (joined) {
        await ctx.editMessageText(
          "✅ Thank you for joining! You can now use the bot.",
        );
      } else {
        await botError(ctx, "You have not joined all required channels yet.");
      }
      return true;
    }

    if (data === "all_menu") {
      await ctx.deleteMessage().catch(() => { });
      await sendAllMenu(ctx);
      return true;
    }

    if (data === "my_info_menu") {
      await ctx.deleteMessage().catch(() => { });
      await sendMyInfoMenu(ctx);
      return true;
    }

    if (data === "learn_features_menu") {
      await ctx.deleteMessage().catch(() => { });
      await sendLearnFeaturesMenu(ctx, "id");
      return true;
    }

    if (data.startsWith("learn_lang_")) {
      const lang = data.replace("learn_lang_", "");
      await ctx.deleteMessage().catch(() => { });
      await sendLearnFeaturesMenu(ctx, lang);
      return true;
    }

    if (data === "action_menu") {
      await ctx.deleteMessage().catch(() => { });
      await sendActionMenu(ctx);
      return true;
    }

    if (data === "back_menu") {
      await ctx.deleteMessage().catch(() => { });
      await sendStartMenu(ctx);
      return true;
    }

    return false;
  }

  return {
    isUserJoinedChannel,
    joinChannelKeyboard,
    sendJoinRequiredMenu,
    sendSXTable,
    sendStartMenu,
    sendActionMenu,
    sendAllMenu,
    sendMyInfoMenu,
    handleMenuCallback,
    botReply,
    botError,
    botSucces,
    botList,
    sendTextResult,
    streamBlocks,
  };
}
