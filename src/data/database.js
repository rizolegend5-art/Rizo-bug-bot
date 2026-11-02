import fs from "fs";
import path from "path";
import { OWNER_ID } from "../config/config.js";

const DB_ROOT = "./database";
const DB_BACKUP_FORMAT = "godline-database-backup";
const DB_BACKUP_VERSION = 1;
const REQUIRED_BACKUP_FILES = [
  "admin.json",
  "bots.json",
  "mode.json",
  "pairs.json",
  "premium.json",
  "users.json",
  "vvip.json",
];
const DURATION_UNITS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

function scopeDir(scope) {
  return scope ? path.join(DB_ROOT, "bots", scope) : DB_ROOT;
}

function dbPath(name, scope) {
  return path.join(scopeDir(scope), `${name}.json`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(name, fallback, scope) {
  try {
    const dir = scopeDir(scope);
    ensureDir(dir);

    const file = dbPath(name, scope);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, data, scope) {
  const dir = scopeDir(scope);
  ensureDir(dir);
  fs.writeFileSync(dbPath(name, scope), JSON.stringify(data, null, 2));
}

function listDatabaseJsonFiles(root = path.resolve(DB_ROOT), relativeDir = "") {
  const directory = path.join(root, relativeDir);
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!relativeDir && entry.name === "backups") return [];
      return listDatabaseJsonFiles(root, relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".json")
      ? [relativePath]
      : [];
  });
}

export function createDatabaseBackup() {
  const root = path.resolve(DB_ROOT);
  const files = {};

  for (const relativePath of listDatabaseJsonFiles(root)) {
    const normalizedPath = relativePath.split(path.sep).join("/");
    files[normalizedPath] = JSON.parse(
      fs.readFileSync(path.join(root, relativePath), "utf8"),
    );
  }

  return {
    format: DB_BACKUP_FORMAT,
    version: DB_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    files,
  };
}

export function restoreDatabaseBackup(backup) {
  if (
    !backup ||
    backup.format !== DB_BACKUP_FORMAT ||
    backup.version !== DB_BACKUP_VERSION ||
    !backup.files ||
    typeof backup.files !== "object" ||
    Array.isArray(backup.files)
  ) {
    throw new Error("Unsupported or invalid database backup file.");
  }

  const missingFiles = REQUIRED_BACKUP_FILES.filter(
    (fileName) => !Object.hasOwn(backup.files, fileName),
  );
  if (missingFiles.length) {
    throw new Error(
      `Backup is incomplete. Missing database files: ${missingFiles.join(", ")}`,
    );
  }

  const root = path.resolve(DB_ROOT);
  const restoredFiles = new Map();

  for (const [relativePath, content] of Object.entries(backup.files)) {
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
    const segments = normalizedRelativePath.split("/");
    if (
      path.isAbsolute(normalizedRelativePath) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !normalizedRelativePath.endsWith(".json") ||
      segments[0] === "backups"
    ) {
      throw new Error(`Invalid database backup path: ${relativePath}`);
    }

    const serialized = JSON.stringify(content, null, 2);
    if (serialized === undefined) {
      throw new Error(`Invalid JSON content for ${relativePath}`);
    }

    const destination = path.resolve(root, ...segments);
    if (!destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Database backup path escapes database folder: ${relativePath}`);
    }
    restoredFiles.set(destination, serialized);
  }

  const existingFiles = listDatabaseJsonFiles(root).map((relativePath) =>
    path.join(root, relativePath),
  );
  const originalContents = new Map(
    existingFiles.map((filePath) => [filePath, fs.readFileSync(filePath)]),
  );

  const backupDirectory = path.join(root, "backups");
  ensureDir(backupDirectory);
  const safetyCopy = path.join(
    backupDirectory,
    `before-restore-${Date.now()}.json`,
  );
  fs.writeFileSync(safetyCopy, JSON.stringify(createDatabaseBackup(), null, 2));

  try {
    for (const filePath of existingFiles) {
      if (!restoredFiles.has(filePath)) fs.rmSync(filePath);
    }

    for (const [filePath, serialized] of restoredFiles) {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, serialized);
    }
  } catch (error) {
    for (const filePath of listDatabaseJsonFiles(root).map((relativePath) =>
      path.join(root, relativePath),
    )) {
      if (!originalContents.has(filePath)) fs.rmSync(filePath);
    }
    for (const [filePath, contents] of originalContents) {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, contents);
    }
    throw error;
  }

  return { restoredCount: restoredFiles.size, safetyCopy };
}

function normalizeStringId(value) {
  return String(value);
}

function normalizeLegacyEntry(entry) {
  if (typeof entry === "string") {
    return { id: entry, expiresAt: null, addedAt: null };
  }

  return {
    id: normalizeStringId(entry.id),
    expiresAt: entry.expiresAt ?? null,
    addedAt: entry.addedAt ?? null,
  };
}

export function parseDuration(input) {
  if (!input) return undefined;

  const value = String(input).trim().toLowerCase();
  const permanentValues = [
    "0",
    "permanent",
    "perm",
    "lifetime",
    "selamanya",
    "unlimited",
  ];

  if (permanentValues.includes(value)) return null;

  const match = value.match(/^(\d+)(mo|[mhdwy])$/);
  if (!match) return undefined;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const durationInMs = amount * DURATION_UNITS[unit];

  return durationInMs > 0 ? durationInMs : undefined;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "Permanent";
  if (ms <= 0) return "Habis";

  const parts = [];
  let remaining = ms;

  const steps = [
    ["y", DURATION_UNITS.y],
    ["mo", DURATION_UNITS.mo],
    ["d", DURATION_UNITS.d],
    ["h", DURATION_UNITS.h],
    ["m", DURATION_UNITS.m],
  ];

  for (const [label, unitMs] of steps) {
    const value = Math.floor(remaining / unitMs);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remaining -= value * unitMs;
    }

    if (parts.length >= 2) break;
  }

  if (!parts.length) return "< 1m";
  return parts.join(" ");
}

export function getAdmins(scope) {
  return readJson("admin", { admins: [] }, scope).admins.map(normalizeStringId);
}

export function addAdmin(id, scope) {
  const data = readJson("admin", { admins: [] }, scope);
  const normalizedId = normalizeStringId(id);
  data.admins = data.admins.map(normalizeStringId);
  if (!data.admins.includes(normalizedId)) data.admins.push(normalizedId);
  writeJson("admin", data, scope);
}

export function removeAdmin(id, scope) {
  const data = readJson("admin", { admins: [] }, scope);
  const normalizedId = normalizeStringId(id);
  data.admins = data.admins
    .map(normalizeStringId)
    .filter((value) => value !== normalizedId);
  writeJson("admin", data, scope);
}

export function getPremiums(scope) {
  const raw = readJson("premium", { premium: [] }, scope);
  const now = Date.now();
  const normalized = raw.premium.map(normalizeLegacyEntry);
  const active = normalized.filter((entry) => !(entry.expiresAt && entry.expiresAt <= now));

  if (
    active.length !== raw.premium.length ||
    JSON.stringify(active) !== JSON.stringify(raw.premium)
  ) {
    writeJson("premium", { premium: active }, scope);
  }

  return active;
}

export function getPremiumEntry(id, scope) {
  return getPremiums(scope).find((entry) => entry.id === normalizeStringId(id)) || null;
}

export function addPremium(id, durationMs = null, scope) {
  const data = readJson("premium", { premium: [] }, scope);
  const normalized = data.premium.map(normalizeLegacyEntry);
  const now = Date.now();
  const expiresAt = typeof durationMs === "number" ? now + durationMs : null;

  const entry = { id: normalizeStringId(id), expiresAt, addedAt: now };
  const index = normalized.findIndex((item) => item.id === entry.id);

  if (index >= 0) normalized[index] = entry;
  else normalized.push(entry);

  writeJson("premium", { premium: normalized }, scope);
  return entry;
}

export function removePremium(id, scope) {
  const data = readJson("premium", { premium: [] }, scope);
  const normalized = data.premium.map(normalizeLegacyEntry);
  const filtered = normalized.filter((entry) => entry.id !== normalizeStringId(id));
  writeJson("premium", { premium: filtered }, scope);
}

export function getVVIPs(scope) {
  const raw = readJson("vvip", { vvip: [] }, scope);
  const now = Date.now();
  const normalized = raw.vvip.map(normalizeLegacyEntry);
  const active = normalized.filter((entry) => !(entry.expiresAt && entry.expiresAt <= now));

  if (
    active.length !== raw.vvip.length ||
    JSON.stringify(active) !== JSON.stringify(raw.vvip)
  ) {
    writeJson("vvip", { vvip: active }, scope);
  }

  return active;
}

export function getVVIPEntry(id, scope) {
  return getVVIPs(scope).find((entry) => entry.id === normalizeStringId(id)) || null;
}

export function addVVIP(id, durationMs = null, scope) {
  const data = readJson("vvip", { vvip: [] }, scope);
  const normalized = data.vvip.map(normalizeLegacyEntry);
  const now = Date.now();
  const expiresAt = typeof durationMs === "number" ? now + durationMs : null;

  const entry = { id: normalizeStringId(id), expiresAt, addedAt: now };
  const index = normalized.findIndex((item) => item.id === entry.id);

  if (index >= 0) normalized[index] = entry;
  else normalized.push(entry);

  writeJson("vvip", { vvip: normalized }, scope);
  return entry;
}

export function removeVVIP(id, scope) {
  const data = readJson("vvip", { vvip: [] }, scope);
  const normalized = data.vvip.map(normalizeLegacyEntry);
  const filtered = normalized.filter((entry) => entry.id !== normalizeStringId(id));
  writeJson("vvip", { vvip: filtered }, scope);
}

export function getMode(scope) {
  return readJson("mode", { mode: "private" }, scope).mode;
}

export function setMode(mode, scope) {
  writeJson("mode", { mode }, scope);
}

export function getUsers() {
  return readJson("users", { users: [] }).users;
}

export function addUser(id) {
  const data = readJson("users", { users: [] });
  const value = normalizeStringId(id);

  if (!data.users.includes(value)) {
    data.users.push(value);
    writeJson("users", data);
    return true;
  }

  return false;
}

export function removeUser(id) {
  const data = readJson("users", { users: [] });
  data.users = data.users.filter((value) => value !== normalizeStringId(id));
  writeJson("users", data);
}

export function getAllPairs() {
  return readJson("pairs", {});
}

export function getPairsForUser(uid) {
  const data = getAllPairs();
  return data[uid] || [];
}

export function addPairNumber(uid, number) {
  const data = getAllPairs();
  if (!data[uid]) data[uid] = [];
  if (!data[uid].includes(number)) data[uid].push(number);
  writeJson("pairs", data);
}

export function removePairNumber(uid, number) {
  const data = getAllPairs();
  if (data[uid]) {
    data[uid] = data[uid].filter((value) => value !== number);
    if (data[uid].length === 0) delete data[uid];
  }
  writeJson("pairs", data);
}

export function clearAllPairs() {
  writeJson("pairs", {});
}

export function getAllBotsRaw() {
  return readJson("bots", {});
}

export function getBotsForUser(uid) {
  return getAllBotsRaw()[String(uid)] || [];
}

export function addBotEntry(uid, token, ownerId) {
  const data = getAllBotsRaw();
  const key = String(uid);
  const normalizedToken = String(token || "").trim();

  if (!data[key]) data[key] = [];
  if (
    Object.values(data).some((entries) =>
      entries.some((entry) => entry.token === normalizedToken),
    )
  ) {
    return false;
  }

  data[key].push({
    token: normalizedToken,
    ownerId: String(ownerId),
    addedAt: Date.now(),
  });
  writeJson("bots", data);
  return true;
}

export function removeBotEntry(uid, token) {
  const data = getAllBotsRaw();
  const key = String(uid);

  if (data[key]) {
    data[key] = data[key].filter((entry) => entry.token !== token);
    if (!data[key].length) delete data[key];
  }

  writeJson("bots", data);
}

export function findBotOwnerUid(token) {
  const data = getAllBotsRaw();
  const query = String(token || "").trim();

  if (!query) return null;

  for (const uid of Object.keys(data)) {
    const match = data[uid].find(
      (entry) => entry.token === query || entry.token.startsWith(query),
    );
    if (match) return uid;
  }

  return null;
}

export function isOwner(id) {
  return String(id) === String(OWNER_ID);
}

export function isAdmin(id, scope) {
  return getAdmins(scope).includes(String(id));
}

export function isPremium(id, scope) {
  return getPremiums(scope).some((entry) => entry.id === String(id));
}

export function isVVIP(id, scope) {
  return getVVIPs(scope).some((entry) => entry.id === String(id));
}

export function hasAccess(id, scope) {
  return isAdmin(id, scope) || isVVIP(id, scope) || isPremium(id, scope);
}

export function canUseBot(id, scope) {
  if (getMode(scope) === "public") return true;
  return hasAccess(id, scope);
}
