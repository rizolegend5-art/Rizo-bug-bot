const VVIP_WINDOW_MS = 15 * 60 * 1000;
const VVIP_LIMIT = 5;
const vvipSenderUsage = new Map();

function getRecentUses(uid) {
  const key = String(uid);
  const now = Date.now();
  const recent = (vvipSenderUsage.get(key) || []).filter(
    (timestamp) => timestamp > now - VVIP_WINDOW_MS,
  );

  vvipSenderUsage.set(key, recent);
  return recent;
}

export function getVVIPUseState(uid) {
  const recent = getRecentUses(uid);
  const used = recent.length;
  const remaining = Math.max(0, VVIP_LIMIT - used);
  const waitMs = used >= VVIP_LIMIT ? Math.max(0, recent[0] + VVIP_WINDOW_MS - Date.now()) : 0;

  return {
    used,
    limit: VVIP_LIMIT,
    remaining,
    windowMs: VVIP_WINDOW_MS,
    waitMs,
    isBlocked: used >= VVIP_LIMIT,
  };
}

export function consumeVVIPSenderUse(uid) {
  const key = String(uid);
  const now = Date.now();
  const recent = getRecentUses(uid);

  if (recent.length >= VVIP_LIMIT) {
    const oldest = recent[0];
    const waitMs = Math.max(0, oldest + VVIP_WINDOW_MS - now);
    return { allowed: false, waitMs };
  }

  recent.push(now);
  vvipSenderUsage.set(key, recent);
  return { allowed: true, waitMs: 0 };
}

export function resetVVIPSenderUse(uid) {
  vvipSenderUsage.delete(String(uid));
  return true;
}

export function formatCooldownText(uid) {
  const state = getVVIPUseState(uid);

  if (!state.isBlocked) {
    return `✅ Ready • ${state.remaining}/${state.limit} left`;
  }

  const totalMs = Math.max(1, state.waitMs);
  const totalSeconds = Math.ceil(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `⏳ Cooldown • ${minutes}m ${seconds}s left`;
  }

  return `⏳ Cooldown • ${seconds}s left`;
}
