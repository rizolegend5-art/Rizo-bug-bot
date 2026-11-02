import "dotenv/config";

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OWNER_ID = String(process.env.OWNER_ID || "");
export const OWNER_USERNAME = process.env.OWNER_USERNAME || "";
export const MENU_PHOTO_URL = process.env.MENU_PHOTO_URL || "";
export const MENU_VIDEO_URL = process.env.MENU_VIDEO_URL || "";
export const MENU_MEDIA_TYPE = (
  process.env.MENU_MEDIA_TYPE ||
  (MENU_VIDEO_URL ? "video" : "photo")
).toLowerCase();
export const MENU_MEDIA_URL =
  process.env.MENU_MEDIA_URL ||
  (MENU_MEDIA_TYPE === "photo" ? MENU_PHOTO_URL : MENU_VIDEO_URL) ||
  MENU_VIDEO_URL ||
  MENU_PHOTO_URL ||
  "";

export const BRANDING = {
  name: "RIZO BUG BOT",
  shortName: "RiZO - Flood",
  tagline: "WhatsApp Multi-Session Bot",
  version: "2.0",
  creator: "@rizohacker33",
  emoji: "🕸",
  footer: "while (true) { RIZO JS }",
};

// Change custom emoji IDs here; menu buttons use these names automatically.
export const CUSTOM_EMOJI = {
  buttons: {
    learn: { id: "5422439311196834318", fallback: "💡" },
    all: { id: "5350505622670435563", fallback: "📂" },
    action: { id: "5251469926002082073", fallback: "🦠" },
    info: { id: "5436113877181941026", fallback: "❓" },
    back: { id: "5357392984981672782", fallback: "⁉️" },
    contact: { id: "5309911073552347903", fallback: "📞" },
  },
  startMenu: {
    status: { id: "5915576233373995623", fallback: "🟢" },
  },
  actionMenu: {
    title: { id: "5251469926002082073", fallback: "🦠" },
    buttons: { id: "5463021280355705884", fallback: "🩸" },
    listcommands: { id: "5260307027372040078", fallback: "🕸" }
  },
  allMenu: {
    title: { id: "5350505622670435563", fallback: "📂" },
    details: { id: "5409150592188690356", fallback: "📋" },
  },
  learnMenu: {
    title: { id: "5422439311196834318", fallback: "💡" },
    details: { id: "5350505622670435563", fallback: "📖" },
  },
  myInfo: {
    account: { id: "5465383954750122781", fallback: "👤" },
    botStatus: { id: "5231200819986047254", fallback: "📊" },
    statistics: { id: "5341715473882955310", fallback: "⚙️" },
  },
};

// One or more channels can be provided as a comma-separated list.
// Example: FORCE_JOIN_CHANNEL=@channel1,@channel2,-1001234567890
export const FORCE_JOIN_CHANNEL = process.env.FORCE_JOIN_CHANNEL || "";
export const FORCE_JOIN_CHANNELS = FORCE_JOIN_CHANNEL.split(",")
  .map((c) => c.trim())
  .filter(Boolean);

export const MAX_PAIR_PER_USER = 5;
export const SESSION_ROOT = "./sessions";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing from .env");
  process.exit(1);
}
if (!OWNER_ID) {
  console.error("❌ OWNER_ID is missing from .env");
  process.exit(1);
}
