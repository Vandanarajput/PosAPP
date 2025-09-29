import RNFS from 'react-native-fs';

const PREF_FILE = `${RNFS.DocumentDirectoryPath}/printer_prefs.json`;

export type Prefs = {
  btAddress?: string;
  btName?: string;
  ip?: string;
  port?: number;
webUrl?: string;  
};

export async function readPrefs(): Promise<Prefs> {
  try {
    const exists = await RNFS.exists(PREF_FILE);
    if (!exists) return {};
    const txt = await RNFS.readFile(PREF_FILE, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

export async function writePrefs(partial: Prefs) {
  try {
    const curr = await readPrefs();
    const next = { ...curr, ...partial };
    await RNFS.writeFile(PREF_FILE, JSON.stringify(next), 'utf8');
  } catch {}
}
