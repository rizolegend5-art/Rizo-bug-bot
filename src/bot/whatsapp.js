import fs from "fs";
import path from "path";
import pino from "pino";
import { Boom } from "@hapi/boom";
import * as baileys from "@whiskeysockets/baileys";
import { log } from "./logger.js";

const makeWASocket =
  baileys.default?.default || baileys.default || baileys.makeWASocket;

const { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } =
  baileys;

import { SESSION_ROOT, OWNER_ID, BRANDING } from "../config/config.js";
import { removePairNumber } from "../data/database.js";

export const waClients = new Map();

const initializingKeys = new Set();
let shuttingDown = false;
const SOCKET_HEALTH_CHECK_MS = 30000;
const SOCKET_IDLE_TIMEOUT_MS = 180000;

function safeRemoveSocketListeners(sock) {
  try {
    sock?.ev?.removeAllListeners?.("connection.update");
  } catch {}
}

function safeCloseSocket(sock) {
  try {
    safeRemoveSocketListeners(sock);
  } catch {}

  try {
    if (sock?.ws?.readyState === 1) sock.ws.close();
  } catch {}

  try {
    if (typeof sock?.end === "function") sock.end();
  } catch {}
}

export function clientKey(uid, number) {
  return `${uid}_${number}`;
}

function getSessionPath(uid, number) {
  return path.join(SESSION_ROOT, String(uid), String(number));
}

function tag(uid, number) {
  return `Key: ${uid} | Number: ${number}`;
}

export function getClient(uid, number) {
  return waClients.get(clientKey(uid, number));
}

export async function shutdownWhatsappSessions() {
  shuttingDown = true;
  const clients = [...waClients.entries()];

  log.warning(`Closing ${clients.length} WhatsApp session(s) for shutdown...`);

  await Promise.allSettled(
    clients.map(async ([key, client]) => {
      client.shuttingDown = true;
      if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
      if (client.healthTimer) clearInterval(client.healthTimer);

      safeCloseSocket(client.sock);

      waClients.delete(key);
      initializingKeys.delete(key);
    }),
  );

  log.success("WhatsApp sessions closed without removing their credentials.");
}

export function describeWhatsappError(err) {
  const statusCode = err?.output?.statusCode ?? err?.data?.output?.statusCode;
  const message = String(
    err?.message || err?.data?.message || err || "Unknown error",
  );

  if (
    statusCode === 401 ||
    /logged.?out|unauthorized|bad session/i.test(message)
  ) {
    return "The WhatsApp session is logged out or invalid. Please pair it again.";
  }
  if (
    statusCode === 403 ||
    /forbidden|connection.?replaced|multidevice/i.test(message)
  ) {
    return "The WhatsApp session was rejected or is being used on another device. Remove it and pair again.";
  }
  if (statusCode === 408 || /timeout|timed out|etimedout/i.test(message)) {
    return "WhatsApp did not respond in time. Check the internet connection and try again.";
  }
  if (/connection closed|socket.*closed|koneksi.*tertutup/i.test(message)) {
    return "The WhatsApp connection closed before the operation completed. Try pairing again.";
  }

  return message.slice(0, 500);
}

async function deleteSessionFiles(uid, number) {
  try {
    await fs.promises.rm(getSessionPath(uid, number), {
      recursive: true,
      force: true,
    });
  } catch {}
}

async function readDirectoryNames(directoryPath) {
  const entries = await fs.promises.readdir(directoryPath, {
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export function sharedSessionKeyFromToken(token) {
  const botId = String(token).split(":")[0];
  return `sub_${botId}`;
}

async function notifyOwner(bot, message) {
  if (!bot?.api || !OWNER_ID) return;
  try {
    await bot.api.sendMessage(OWNER_ID, `🚨 *WA ERROR LOG*\n\n${message}`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    log.error(`Failed to notify the owner: ${err.message}`);
  }
}

function getReconnectDelay(retryCount) {
  const base = 5000;
  const exponential = Math.min(base * 2 ** retryCount, 90000);
  const jitter = Math.floor(Math.random() * 2000);
  return exponential + jitter;
}

export async function initWhatsappForNumber(
  bot,
  uid,
  number,
  retryCount = 0,
  notifyTarget = null,
  opts = {},
) {
  const MAX_RETRIES = Number.POSITIVE_INFINITY;
  const key = clientKey(uid, number);
  const sessionPath = getSessionPath(uid, number);
  const notifyTo = notifyTarget || uid;
  const forceNew = !!opts.forceNew;

  const oldClient = waClients.get(key);

  // forceNew dipakai khusus alur /pair: pairing HARUS selalu mulai dari socket
  // & auth state yang benar-benar bersih. Kalau tidak, socket/file sisa dari
  // percobaan pairing sebelumnya (yang gagal/timeout dan nyangkut) bisa kereuse
  // tanpa minta kode baru, sehingga kode yang ditampilkan ke user gak sinkron
  // lagi sama sesi yang aktif di server WhatsApp -> muncul sebagai "kode salah"
  // padahal user ngetiknya benar.
  if (!forceNew) {
    // kalau session udah beneran kebuka, jangan init ulang
    if (oldClient?.sock && oldClient.status === "open") {
      log.info(
        `Session is already active; skipping initialization | ${tag(uid, number)}`,
      );
      return oldClient.sock;
    }

    // kalau lagi proses connecting, JANGAN bikin socket kedua buat key yang sama.
    // Ini penyebab utama "closed anomali": 2 socket buat 1 nomor bikin WhatsApp
    // nutup salah satunya dengan reason connectionReplaced, dikira logout.
    if (oldClient?.sock && oldClient.status === "connecting") {
      log.warning(
        `Session masih dalam proses connecting, skip init dobel | ${tag(uid, number)}`,
      );
      return oldClient.sock;
    }
  }

  if (initializingKeys.has(key)) {
    if (forceNew) {
      // Jangan diam-diam ngereuse punya proses lain yang lagi jalan buat
      // kebutuhan pairing baru — mending gagal jelas, biar handler di atas
      // The command handler can report that another process is still running,
      // daripada nampilin kode yang gak jelas punya proses mana.
      throw new Error(
        "Another connection process is already running for this number. Try again shortly.",
      );
    }
    log.warning(
      `Initialization is already running; skipping duplicate | ${tag(uid, number)}`,
    );
    return oldClient?.sock || null;
  }
  initializingKeys.add(key);

  try {
    if (forceNew && oldClient) {
      // Matiin & buang socket lama yang nyangkut sebelum mulai yang baru.
      log.warning(
        `Membersihkan socket lama sebelum pairing baru | ${tag(uid, number)}`,
      );
      try {
        oldClient.sock?.ev?.removeAllListeners?.("connection.update");
      } catch {}
      try {
        await oldClient.sock?.end?.();
      } catch {}
      try {
        oldClient.sock?.ws?.close?.();
      } catch {}
      waClients.delete(key);
    }

    if (forceNew) {
      // Auth state lama (walau belum "registered") bisa bikin requestPairingCode
      // berperilaku aneh kalau dipakai ulang. Untuk pairing baru, selalu mulai
      // dari creds kosong.
      await deleteSessionFiles(uid, number);
    }

    if (!fs.existsSync(sessionPath))
      fs.mkdirSync(sessionPath, { recursive: true });

    log.loading(`Connecting WhatsApp... | ${tag(uid, number)}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: "silent" }),
        ),
      },
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      retryRequestDelayMs: 500,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", () => {
      const client = waClients.get(key);
      if (client) {
        client.lastSeenAt = Date.now();
      }
    });

    function startSocketHealthGuard() {
      const client = waClients.get(key);
      if (!client || client.healthTimer) return;

      client.lastSeenAt = Date.now();
      client.healthTimer = setInterval(async () => {
        const latest = waClients.get(key);
        if (!latest || latest.sock !== sock) {
          if (client.healthTimer) clearInterval(client.healthTimer);
          return;
        }

        if (latest.status !== "open") return;
        if (latest.keepAliveInFlight) return;

        const idleMs = Date.now() - (latest.lastSeenAt || Date.now());
        if (idleMs < SOCKET_IDLE_TIMEOUT_MS) return;

        latest.keepAliveInFlight = true;
        let pingTimeout;
        try {
          await Promise.race([
            sock.sendPresenceUpdate("available"),
            new Promise((_, reject) => {
              pingTimeout = setTimeout(
                () => reject(new Error("WhatsApp keepalive timed out")),
                10000,
              );
            }),
          ]);
          latest.lastSeenAt = Date.now();
          log.info(
            `WA keepalive ping sent | ${tag(uid, number)} | idleMs=${idleMs}`,
          );
        } catch (err) {
          log.warning(
            `WA keepalive failed | ${tag(uid, number)} | ${describeWhatsappError(err)}`,
          );
          clearInterval(latest.healthTimer);
          latest.healthTimer = null;
          latest.status = "closed";
          latest.reconnecting = false;

          // Stop the unhealthy socket before scheduling a replacement. This
          // prevents the old socket from emitting a second close event while
          // the replacement is being initialized.
          safeCloseSocket(sock);

          if (!shuttingDown && !latest.shuttingDown) {
            latest.reconnectTimer = setTimeout(() => {
              if (!waClients.has(key) || !fs.existsSync(sessionPath)) {
                initializingKeys.delete(key);
                return;
              }

              const active = waClients.get(key);
              if (!active || active.status === "closed") {
                if (active) active.reconnectTimer = null;
                initializingKeys.delete(key);
                initWhatsappForNumber(bot, uid, number, retryCount + 1, notifyTo).catch(
                  (err) => {
                    log.error(
                      `Health-based reconnect failed | ${tag(uid, number)} | ${err.message}`,
                    );
                  },
                );
              }
            }, 2000);
          }
        } finally {
          clearTimeout(pingTimeout);
          const current = waClients.get(key);
          if (current?.sock === sock) current.keepAliveInFlight = false;
        }
      }, SOCKET_HEALTH_CHECK_MS);
    }

    // isPairing: true selama BELUM PERNAH open sama sekali. Selama flag ini
    // true, close-code yang mirip "logout" (401/403/connectionReplaced) TIDAK
    // dianggap logout beneran — soalnya WhatsApp emang sering ngirim close-code
    // begituan pas fase awal pairing, padahal itu bagian normal dari handshake.
    waClients.set(key, {
      sock,
      status: "connecting",
      reconnecting: false,
      // Only a deliberate /pair flow is pairing. Restored sessions must be
      // allowed to reconnect without treating a transient close as failure.
      isPairing: forceNew,
      fatalStrikes: forceNew ? 0 : (oldClient?.fatalStrikes ?? 0),
      openedAt: forceNew ? null : (oldClient?.openedAt ?? null),
      healthTimer: null,
      keepAliveInFlight: false,
      reconnectTimer: null,
      lastSeenAt: Date.now(),
    });

    sock.waitForOpen = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while waiting for WhatsApp to connect"));
      }, 60000);

      sock.ev.on("connection.update", (update) => {
        if (update.connection === "open") {
          clearTimeout(timeout);
          resolve(true);
        }
        if (update.connection === "close") {
          clearTimeout(timeout);
          reject(new Error("The WhatsApp connection closed"));
        }
      });
    });
    sock.waitForOpen.catch(() => {});

    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update || {};
        const client = waClients.get(key);

        // GUARD PENTING: pastiin event ini beneran datang dari socket yang
        // SAAT INI aktif buat key ini. Socket lama yang udah digantiin
        // (reconnect/pairing baru) kadang masih sempat nembak event closed
        // telat (listener-nya belum ke-remove sempurna, atau ada timer
        // internal Baileys yang telat nembak). Tanpa guard ini, event basi
        // dari socket lama bisa "numpang" ngerusak state socket BARU yang
        // sebenarnya sehat — fatalStrikes/retryCount kebawa naik walau
        // koneksi yang aktif gak pernah beneran bermasalah. Ini penyebab
        // utama kasus "udah kesambung, eh reconnect lagi, gitu terus sampe
        // 5x kehapus" padahal dari luar keliatannya normal.
        if (!client || client.sock !== sock) {
          log.warning(
            `Stale event from an old socket ignored (not the active socket) | ${tag(uid, number)}`,
          );
          return;
        }

        if (connection === "close") {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const detail = describeWhatsappError(lastDisconnect?.error);
          if (client) {
            client.status = "closed";
            client.lastSeenAt = Date.now();
            if (client.healthTimer) {
              clearInterval(client.healthTimer);
              client.healthTimer = null;
            }
          }

          log.warning(
            `WA close event | ${tag(uid, number)} | reason=${reason ?? "unknown"} | detail=${detail}`,
          );

          if (shuttingDown || client?.shuttingDown) {
            initializingKeys.delete(key);
            return;
          }

          if (reason === DisconnectReason.restartRequired) {
            if (!waClients.has(key) || !fs.existsSync(sessionPath)) {
              log.warning(
                `Connection restart cancelled; session was removed | ${tag(uid, number)}`,
              );
              initializingKeys.delete(key);
              return;
            }
            log.info(
              `Restarting connection (normal pairing flow) | ${tag(uid, number)}`,
            );
            try {
              sock.ev?.removeAllListeners?.("connection.update");
            } catch {}
            initializingKeys.delete(key);
            initWhatsappForNumber(bot, uid, number, 0, notifyTo).catch(
              (err) => {
                log.error(
                  `Connection restart failed | ${tag(uid, number)} | ${err.message}`,
                );
              },
            );
            return;
          }

          // loggedOut (401) = sinyal EKSPLISIT dari WhatsApp: user beneran
          // cabut sesi ini dari HP-nya (linked device dihapus manual).
          // Ini gak ambigu, aman buat langsung dihapus.
          const isDefiniteLogout =
            reason === DisconnectReason.loggedOut || reason === 401;

          // Sinyal2 ini KADANG false-positive, khususnya tepat setelah bot
          // di-restart: socket lama (dari proses sebelumnya) belum bener2
          // "beres" di sisi server WA, jadi socket baru sempat kebaca
          // connectionReplaced/403/badSession padahal cuma gesekan sesaat,
          // BUKAN logout beneran. Kalau langsung dihapus, sesi yang sehat
          // ikut kehapus tiap kali bot restart.
          const isSuspectedFatal =
            reason === DisconnectReason.connectionReplaced ||
            reason === DisconnectReason.badSession ||
            reason === DisconnectReason.multideviceMismatch ||
            reason === 403;

          // Pairing phase is strictly "not yet open". If a pairing socket sees
          // any logout/forbidden/replaced/badSession signal in this window, it
          // is a hard pairing failure, not a recoverable active session. Do not
          // let the reconnect timer or health timer survive. Do not continue the
          // old socket's connection state into a new pairing run.
          if ((isDefiniteLogout || isSuspectedFatal) && client?.isPairing) {
            log.warning(
              `Pairing close signal detected and discarded safely | ${tag(uid, number)} | reason=${reason ?? "unknown"}`,
            );

            if (client.reconnectTimer) {
              clearTimeout(client.reconnectTimer);
              client.reconnectTimer = null;
            }
            if (client.healthTimer) {
              clearInterval(client.healthTimer);
              client.healthTimer = null;
            }
            client.status = "closed";
            client.reconnecting = false;
            client.isPairing = false;

            try {
              safeRemoveSocketListeners(sock);
              safeCloseSocket(sock);
            } catch {}

            waClients.delete(key);
            initializingKeys.delete(key);
            await deleteSessionFiles(uid, number);
            return;
          }

          if (isDefiniteLogout && !client?.isPairing) {
            log.error(
              `Confirmed logout (401); session removed automatically | ${tag(uid, number)}`,
            );

            await deleteSessionFiles(uid, number);
            removePairNumber(String(uid), number);
            waClients.delete(key);
            initializingKeys.delete(key);

            await notifyOwner(
              bot,
              `Number \`${number}\` (key \`${uid}\`) logged out (reason: ${reason}). The session was removed automatically.`,
            );

            try {
              await bot.api.sendMessage(
                notifyTo,
                `🚫 *WhatsApp disconnected*\nNumber ${number} was logged out; the session was removed.`,
                { parse_mode: "Markdown" },
              );
            } catch {}
            return;
          }

          // A replaced/bad-session signal is not enough to delete credentials.
          // During restarts and network changes Baileys can emit these codes
          // before the saved credentials are accepted by the new socket.
          if (isSuspectedFatal && !client?.isPairing) {
            const strikes = (client.fatalStrikes || 0) + 1;
            client.fatalStrikes = strikes;
            log.warning(
              `Recoverable session signal (${reason}) received (${strikes}); credentials kept and reconnect will continue | ${tag(uid, number)}`,
            );
          }

          // STABILITY RESET: kalau socket ini sempat open & stabil cukup
          // lama (>= 2 menit) sebelum putus lagi, anggap putusnya sekarang
          // sebagai kejadian baru yang berdiri sendiri — bukan bagian dari
          // loop gagal beruntun. retryCount di-reset ke 0 biar sesi yang
          // sebenarnya sehat gak kehabisan "jatah" cuma gara-gara network
          // blip sesekali yang numpuk selama masa hidup sesi yang panjang.
          // Kalau putusnya cepat (belum sempat stabil), retryCount tetap
          // naik seperti biasa — supaya loop gagal beruntun yang beneran
          // rusak tetap kena limit & kehapus.
          const STABLE_MS = 2 * 60 * 1000;
          const wasStable =
            client?.openedAt && Date.now() - client.openedAt >= STABLE_MS;
          const effectiveRetryCount = wasStable ? 0 : retryCount;
          if (wasStable) {
            log.info(
              `Stable for ${Math.round((Date.now() - client.openedAt) / 1000)}s before disconnect; retry count reset | ${tag(uid, number)}`,
            );
          }

          if (
            client &&
            !client.reconnecting &&
            effectiveRetryCount < MAX_RETRIES
          ) {
            client.reconnecting = true;
            const delay = getReconnectDelay(effectiveRetryCount);
            log.warning(
              `Terputus | ${tag(uid, number)} | reason=${reason ?? "unknown"} | detail=${describeWhatsappError(lastDisconnect?.error)} | reconnecting dalam ${Math.round(delay / 1000)}s (${effectiveRetryCount + 1}/${MAX_RETRIES})...`,
            );

            client.reconnectTimer = setTimeout(() => {
              // GUARD PENTING: sebelum beneran reconnect, cek dulu apakah
              // sesi ini masih valid. Delay reconnect bisa sampai puluhan
              // detik — kalau di jeda itu sesinya udah dihapus manual
              // (logout/endWhatsappForNumber/clearAllSessions), folder
              // session-nya bakal hilang & entry-nya kebuang dari
              // waClients. Tanpa cek ini, timer bakal tetap maksa
              // initWhatsappForNumber() dan bikin folder+socket baru
              // dari creds kosong -> pasti gagal/error, padahal
              // penghapusannya memang disengaja.
              if (!waClients.has(key) || !fs.existsSync(sessionPath)) {
                log.warning(
                  `Reconnect cancelled; session was removed or no longer exists | ${tag(uid, number)}`,
                );
                initializingKeys.delete(key);
                return;
              }

              const c = waClients.get(key);
              if (c) c.reconnecting = false;
              // Buang listener socket lama sebelum bikin socket baru,
              // biar gak ada listener nyangkut lama-lama (memory leak)
              // dan mengurangi peluang event basi nempel lebih jauh.
              try {
                sock.ev?.removeAllListeners?.("connection.update");
              } catch {}
              initializingKeys.delete(key);
              initWhatsappForNumber(
                bot,
                uid,
                number,
                effectiveRetryCount + 1,
                notifyTo,
              ).catch((err) => {
                log.error(
                  `Reconnect failed | ${tag(uid, number)} | ${err.message}`,
                );
              });
            }, delay);
          }
        } else if (connection === "open") {
          if (client) {
            client.status = "open";
            client.isPairing = false;
            client.reconnecting = false;
            client.fatalStrikes = 0;
            client.openedAt = Date.now();
            client.lastSeenAt = Date.now();
            if (client.healthTimer) clearInterval(client.healthTimer);
            startSocketHealthGuard();
          }
          initializingKeys.delete(key);
          log.success(`WhatsApp connected! | ${tag(uid, number)}`);
        } else if (connection === "connecting") {
          if (client) {
            client.status = "connecting";
            client.lastSeenAt = Date.now();
          }
        }
      } catch (err) {
        log.error(
          `Error internal connection.update | ${tag(uid, number)} | ${err.message}`,
        );
        await notifyOwner(
          bot,
          `Error internal di handler koneksi\n${tag(uid, number)}\n\n\`${describeWhatsappError(err)}\``,
        );
      }
    });

    return sock;
  } finally {
    // FIX: sebelumnya ada bug operator precedence di sini
    // (`!x === "open"` selalu false, jadi baris ini gak pernah jalan sama
    // sekali dan bikin initializingKeys nyangkut -> race -> socket dobel ->
    // WhatsApp nutup salah satu sebagai "connectionReplaced" -> session
    // kehapus padahal gak ada yang beneran logout).
    setTimeout(() => {
      if (waClients.get(key)?.status !== "open") {
        initializingKeys.delete(key);
      }
    }, 5000);
  }
}

// ----------- ( fungsi: waitForPairSuccess, khusus dipakai flow /pair ) ------------ //

export function waitForPairSuccess(uid, number, timeoutMs = 100000) {
  return new Promise((resolve, reject) => {
    const key = clientKey(uid, number);
    const start = Date.now();

    const interval = setInterval(() => {
      const client = waClients.get(key);

      if (client?.status === "open") {
        clearInterval(interval);
        resolve(true);
        return;
      }

      if (!client) {
        clearInterval(interval);
        reject(
          new Error(
            "Pairing failed; the session was removed, possibly due to logout or a ban",
          ),
        );
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out while waiting for WhatsApp to connect"));
      }
    }, 1000);
  });
}

// ----------- ( fungsi: loadAllWhatsappSessions, restore sesi bot UTAMA pas startup ) ------------ //

export async function loadAllWhatsappSessions(bot) {
  log.loading("Memulai restore semua session WhatsApp (bot utama)...");

  if (!fs.existsSync(SESSION_ROOT)) {
    log.warning("Folder session tidak ditemukan, tidak ada yang di-restore.");
    return;
  }

  let userIds;
  try {
    userIds = (await readDirectoryNames(SESSION_ROOT)).filter(
      (uid) => !uid.startsWith("sub_"),
    );
  } catch (err) {
    log.error(`Unable to scan WhatsApp session root: ${err.message}`);
    return;
  }

  if (!userIds.length) {
    log.warning("Folder session kosong, tidak ada yang di-restore.");
    return;
  }

  let successCount = 0;
  let failedCount = 0;

  for (const uid of userIds) {
    const userPath = path.join(SESSION_ROOT, uid);
    let numbers;
    try {
      numbers = await readDirectoryNames(userPath);
    } catch (err) {
      failedCount += 1;
      log.error(`Unable to scan session folder for user ${uid}: ${err.message}`);
      continue;
    }

    if (!numbers.length) continue;

    log.info(`User ${uid} — ditemukan ${numbers.length} session tersimpan`);

    for (const number of numbers) {
      try {
        log.loading(`Restore session... | ${tag(uid, number)}`);
        await initWhatsappForNumber(bot, uid, number);
        successCount++;
        // Jeda + jitter antar restore, biar socket-socket ini gak dibuka
        // barengan semua. Restore serentak bikin beban ke WA numpuk pas
        // startup, salah satu pemicu sinyal "connectionReplaced"/403 palsu
        // yang bisa disalahartikan sebagai logout.
        await new Promise((r) =>
          setTimeout(r, 1500 + Math.floor(Math.random() * 1000)),
        );
      } catch (err) {
        failedCount++;
        const detail = describeWhatsappError(err);
        log.error(`Session restore failed | ${tag(uid, number)} | ${detail}`);
        await notifyOwner(
          bot,
          `Session restore failed\n${tag(uid, number)}\n\n\`${detail}\``,
        );
      }
    }
  }

  log.success(
    `${BRANDING.name} restore complete — 🟢 ${successCount} successful, 🔴 ${failedCount} failed`,
  );
}

// ----------- ( fungsi: restoreSessionsForKey, khusus 1 key tertentu ) ------------ //

export async function restoreSessionsForKey(
  bot,
  sessionKey,
  notifyTarget = null,
) {
  const userPath = path.join(SESSION_ROOT, String(sessionKey));
  if (!fs.existsSync(userPath)) return;

  let numbers;
  try {
    numbers = await readDirectoryNames(userPath);
  } catch (err) {
    log.error(
      `Unable to scan shared session folder for key ${sessionKey}: ${err.message}`,
    );
    return;
  }

  if (!numbers.length) return;

  log.info(
    `Restoring shared sessions for key ${sessionKey} — ${numbers.length} number(s) found`,
  );

  for (const number of numbers) {
    try {
      log.loading(`Restore shared session... | ${tag(sessionKey, number)}`);
      await initWhatsappForNumber(bot, sessionKey, number, 0, notifyTarget);
      await new Promise((r) =>
        setTimeout(r, 1500 + Math.floor(Math.random() * 1000)),
      );
    } catch (err) {
      log.error(
        `Shared session restore failed | ${tag(sessionKey, number)} | ${describeWhatsappError(err)}`,
      );
    }
  }
}

// ----------- ( fungsi: waitForConnection, backward-compat ) ------------ //

export function waitForConnection(sock, timeout = 90000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error("Timeout menunggu WhatsApp terhubung"));
    }, timeout);

    const handler = (update) => {
      const { connection } = update;

      if (connection === "open") {
        clearTimeout(timer);
        sock.ev.off("connection.update", handler);
        resolve(true);
      }

      if (connection === "close") {
        clearTimeout(timer);
        sock.ev.off("connection.update", handler);
        reject(new Error("Pairing failed because the connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

// ----------- ( fungsi: endWhatsappForNumber, hapus 1 sesi ) ------------ //

export async function endWhatsappForNumber(uid, number) {
  const key = clientKey(uid, number);
  const client = waClients.get(key);

  log.warning(`Removing session... | ${tag(uid, number)}`);

  if (client) {
    client.shuttingDown = true;
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    if (client.healthTimer) clearInterval(client.healthTimer);
    safeCloseSocket(client.sock);
  }

  waClients.delete(key);
  initializingKeys.delete(key);
  await deleteSessionFiles(uid, number);

  log.success(`Session removed successfully | ${tag(uid, number)}`);
}

// ----------- ( fungsi: clearAllSessions, hapus semua sesi ) ------------ //

export async function clearAllSessions() {
  const total = waClients.size;
  log.warning(`Removing ALL WhatsApp sessions (${total} active)...`);

  for (const key of [...waClients.keys()]) {
    const client = waClients.get(key);
    if (client) {
      client.shuttingDown = true;
      if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
      if (client.healthTimer) clearInterval(client.healthTimer);
      safeCloseSocket(client.sock);
    }
    waClients.delete(key);
    initializingKeys.delete(key);
  }

  try {
    await fs.promises.rm(SESSION_ROOT, { recursive: true, force: true });
    fs.mkdirSync(SESSION_ROOT, { recursive: true });
    log.success(`All sessions (${total}) removed successfully.`);
  } catch (err) {
    log.error(`Failed to clear the session folder: ${err.message}`);
  }
}
