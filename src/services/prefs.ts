// src/prefs.ts
import RNFS from 'react-native-fs';

const PREF_FILE = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;

// Defaults for new multi-network-printer support
export const DEFAULT_NET_PORT = 9100;
export const DEFAULT_WIDTH_DOTS = 576; // 80mm printers; use 384 for many 58mm models

// Supported paper widths (dots)
export type WidthDots = 384 | 576;

// NOTE: We are doing IP-only matching from JSON. `name` is just a human label for UI.
export type NetPrinterProfile = {
  /** Human label for UI only (NOT used for matching). */
  name: string;
  /** IP or hostname, e.g. "192.168.1.50". Used for exact matching. */
  host: string;
  /** Port, default 9100. */
  port?: number;
  /** 576 (80mm) or 384 (58mm). */
  widthDots?: WidthDots;
  /** Enable/disable without deleting. Defaults to true. */
  enabled?: boolean;
  /** Copies per job for this device. Defaults to 1. */
  copies?: number;
  /** Fallback when no JSON IP matches. */
  isDefault?: boolean;
};

export type Prefs = {
  btAddress?: string;
  btName?: string;

  // Legacy single-printer fields (kept for compatibility/migration)
  ip?: string;
  port?: number;

  webUrl?: string;

  // Multi-network-printer support (additive, non-breaking)
  netPrinters?: NetPrinterProfile[];
  enableMultiNet?: boolean; // feature flag: false by default
};

// ---------- Internal helpers ----------

/** Ensure profile has all defaults filled. Does not mutate the original object. */
function normalizeProfile(p: NetPrinterProfile): NetPrinterProfile {
  return {
    name: p.name ?? p.host ?? 'Printer',
    host: p.host,
    port: (typeof p.port === 'number' && p.port > 0) ? p.port : DEFAULT_NET_PORT,
    widthDots:
      p.widthDots === 384 || p.widthDots === 576 ? p.widthDots : DEFAULT_WIDTH_DOTS,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    copies: typeof p.copies === 'number' && p.copies > 0 ? p.copies : 1,
    isDefault: !!p.isDefault,
  };
}

/** Make sure the full prefs object has safe defaults. */
function normalizePrefs(raw: any): Prefs {
  const prefs: Prefs = (raw && typeof raw === 'object') ? raw : {};

  // Feature flag defaults to false (no behavior change until you enable it)
  if (typeof prefs.enableMultiNet !== 'boolean') {
    prefs.enableMultiNet = false;
  }

  // Ensure netPrinters is an array
  if (!Array.isArray(prefs.netPrinters)) {
    prefs.netPrinters = [];
  }

  // One-time, in-memory migration: if legacy ip/port exist and no profiles yet,
  // seed a "Default" profile so routing can work immediately.
  if (prefs.netPrinters.length === 0 && prefs.ip) {
    prefs.netPrinters.push({
      name: 'Default',
      host: prefs.ip,
      port: (typeof prefs.port === 'number' && prefs.port > 0) ? prefs.port : DEFAULT_NET_PORT,
      widthDots: DEFAULT_WIDTH_DOTS,
      enabled: true,
      copies: 1,
      isDefault: true,
    });
    // NOTE: We do NOT write back here to avoid side effects in read().
    // The normalized object returned will include the seeded profile for this run.
  }

  // Normalize every saved printer profile
  prefs.netPrinters = prefs.netPrinters.map(normalizeProfile);

  return prefs;
}

/** Parse an ip token which may be "IP" or "IP:port". Returns {host, port?}. */
function parseIpToken(ipToken: string): { host: string; port?: number } | null {
  if (typeof ipToken !== 'string' || ipToken.trim() === '') return null;
  const token = ipToken.trim();

  // If token ends with ":<digits>", treat suffix as port; otherwise, host only.
  const portMatch = token.match(/:(\d{2,5})$/); // simple, IPv4-friendly
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    const host = token.slice(0, token.length - portMatch[0].length);
    if (!host) return null;
    return { host, port };
  }
  return { host: token };
}

// ---------- Public API ----------

export async function readPrefs(): Promise<Prefs> {
  try {
    const exists = await RNFS.exists(PREF_FILE);
    if (!exists) return normalizePrefs({});
    const txt = await RNFS.readFile(PREF_FILE, 'utf8');
    const parsed = JSON.parse(txt || '{}');
    return normalizePrefs(parsed);
  } catch {
    return normalizePrefs({});
  }
}

export async function writePrefs(partial: Prefs) {
  try {
    const curr = await readPrefs();
    // Shallow merge is fine; arrays/objects provided in `partial` will replace.
    const next = normalizePrefs({ ...curr, ...partial });
    await RNFS.writeFile(PREF_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // no-op
  }
}

/** Convenience: get the normalized list of saved network printers. */
export async function getNetPrinters(): Promise<NetPrinterProfile[]> {
  const prefs = await readPrefs();
  return prefs.netPrinters ?? [];
}

/** Convenience: overwrite the entire saved list of network printers. */
export async function setNetPrinters(list: NetPrinterProfile[]): Promise<void> {
  // Normalize on write to guarantee defaults
  const normalized = (list ?? []).map(normalizeProfile);
  await writePrefs({ netPrinters: normalized });
}

/** Read the multi-LAN feature flag. */
export async function getEnableMultiNet(): Promise<boolean> {
  const prefs = await readPrefs();
  return !!prefs.enableMultiNet;
}

/** Set the multi-LAN feature flag. */
export async function setEnableMultiNet(value: boolean): Promise<void> {
  await writePrefs({ enableMultiNet: !!value });
}

/**
 * Resolve a saved printer by exact IP token from JSON.
 * - Accepts "IP" or "IP:port".
 * - Matches on host equality; if port is provided, match on both.
 * Returns the matching profile or undefined.
 */
export async function resolveSavedPrinterByIpToken(
  ipToken: string
): Promise<NetPrinterProfile | undefined> {
  const parts = parseIpToken(ipToken);
  if (!parts) return undefined;

  const { host, port } = parts;
  const list = await getNetPrinters();

  // Exact IP (host) match first, with optional port equality if provided
  const match = list.find(p => {
    if (!p.enabled) return false;
    const hostOk = p.host === host;
    if (!hostOk) return false;
    if (typeof port === 'number') {
      const pPort = (typeof p.port === 'number' && p.port > 0) ? p.port : DEFAULT_NET_PORT;
      return pPort === port;
    }
    return true; // no port specified in token -> host equality is enough
  });

  return match;
}

/**
 * Version that works with an already-loaded list (avoids extra I/O in hot paths).
 * Useful if you already read prefs once in your component.
 */
export function resolveSavedPrinterByIpTokenInList(
  ipToken: string,
  list: NetPrinterProfile[]
): NetPrinterProfile | undefined {
  const parts = parseIpToken(ipToken);
  if (!parts) return undefined;

  const { host, port } = parts;
  // Ensure list items have defaults (in case caller passed raw data)
  const normalizedList = (list ?? []).map(normalizeProfile);

  return normalizedList.find(p => {
    if (!p.enabled) return false;
    const hostOk = p.host === host;
    if (!hostOk) return false;
    if (typeof port === 'number') {
      const pPort = (typeof p.port === 'number' && p.port > 0) ? p.port : DEFAULT_NET_PORT;
      return pPort === port;
    }
    return true;
  });
}
