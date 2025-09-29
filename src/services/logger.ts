// src/services/logger.ts
import { Platform, PermissionsAndroid } from 'react-native';
import RNFS from 'react-native-fs';

const PUBLIC_DIR =
  Platform.OS === 'android'
    ? `${RNFS.DownloadDirectoryPath}/Techsapphire`   // = /storage/emulated/0/Download/Techsapphire
    : `${RNFS.DocumentDirectoryPath}/Techsapphire`; // iOS fallback

export const LOG_PATH = `${PUBLIC_DIR}/app.log`;
export const PREF_PRIVATE_PATH = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;
export const PREF_PUBLIC_PATH  = `${PUBLIC_DIR}/printer_prefs.json`;

// Android 9 and below need WRITE_EXTERNAL_STORAGE to write into /Download
async function maybeAskLegacyWritePerm() {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  if (api <= 28) {
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  }
  return true; // Android 10+ (scoped storage) — Download path works without this perm
}

async function ensureDir() {
  try { await RNFS.mkdir(PUBLIC_DIR); } catch {}
}

export async function appendLog(line: string) {
  try {
    if (Platform.OS === 'android') {
      const ok = await maybeAskLegacyWritePerm();
      if (!ok) return;
    }
    await ensureDir();
    const stamp = new Date().toISOString();
    const text = `[${stamp}] ${line}\n`;
    const exists = await RNFS.exists(LOG_PATH);
    if (!exists) await RNFS.writeFile(LOG_PATH, text, 'utf8');
    else await RNFS.appendFile(LOG_PATH, text, 'utf8');
  } catch {
    // ignore logging failures
  }
}

// Make a visible copy of your saved device prefs
export async function mirrorPrefsToPublic() {
  try {
    const exists = await RNFS.exists(PREF_PRIVATE_PATH);
    if (!exists) return;
    if (Platform.OS === 'android') {
      const ok = await maybeAskLegacyWritePerm();
      if (!ok) return;
    }
    await ensureDir();
    const txt = await RNFS.readFile(PREF_PRIVATE_PATH, 'utf8');
    await RNFS.writeFile(PREF_PUBLIC_PATH, txt, 'utf8');
    await appendLog(`Prefs mirrored to: ${PREF_PUBLIC_PATH}`);
  } catch (e: any) {
    await appendLog(`Prefs mirror error: ${e?.message || String(e)}`);
  }
}

// Optional: mirror console.* into app.log for easy debugging
export function hookConsoleToFile() {
  const _log = console.log?.bind(console);
  const _warn = console.warn?.bind(console);
  const _error = console.error?.bind(console);

  const toStr = (a: any) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());

  console.log = (...args: any[]) => { _log?.(...args); appendLog(`[LOG] ${args.map(toStr).join(' ')}`); };
  console.warn = (...args: any[]) => { _warn?.(...args); appendLog(`[WARN] ${args.map(toStr).join(' ')}`); };
  console.error = (...args: any[]) => { _error?.(...args); appendLog(`[ERROR] ${args.map(toStr).join(' ')}`); };

  appendLog('=== Techsapphire logger hooked ===');
}
