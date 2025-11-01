// src/screens/DrawerContent.tsx
import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  Alert,
  TextInput,
  Platform,
  PermissionsAndroid,
  ActivityIndicator,
  Modal,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  DeviceEventEmitter,
  AppState,
  Switch,
} from 'react-native';
import { DrawerContentScrollView, type DrawerContentComponentProps } from '@react-navigation/drawer';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { BLEPrinterService } from '../transports/blePrinter';
import { NetPrinterService } from '../transports/netPrinter';
import { renderReceipt } from '../services/receiptRenderer';
import receiptJson from '../assets/receipt.json';

import {
  readPrefs,
  writePrefs,
  getNetPrinters,
  setNetPrinters,
  getEnableMultiNet,
  setEnableMultiNet,
  DEFAULT_NET_PORT,
  DEFAULT_WIDTH_DOTS,
} from '../services/prefs';
import type { NetPrinterProfile } from '../services/prefs';
import { appendLog, mirrorPrefsToPublic } from '../services/logger';

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
const sleep = (ms: number) => new Promise<void>(res => setTimeout(() => res(), ms));

const WIDTH_DOTS = 576;
const LOGO_SCALE = 0.55;

const PRIMARY = '#6D28D9';
const BORDER = '#E5E7EB';
const SUBTLE = '#6B7280';
const DISABLED_BG = '#F1EFF9';
const DISABLED_TXT = '#8C7DB5';
const RED = '#EF4444';

async function ensureBtPerms() {
  if (Platform.OS !== 'android') return true;
  const res = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    // @ts-ignore
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    // @ts-ignore
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
  ] as any);
  return Object.values(res).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
}

// tiny getters
function get(obj: any, path: string, fallback?: any) {
  try {
    const segs = path.split('.').filter(Boolean);
    let cur = obj;
    for (const s of segs) cur = cur?.[s];
    return cur ?? fallback;
  } catch { return fallback; }
}
const asStrArray = (v: any) =>
  Array.isArray(v) ? v.filter((x: any) => typeof x === 'string' && x.trim()) :
  (typeof v === 'string' && v.trim() ? [v.trim()] : []);

// ------- robust IP helpers -------
function parseIpToken(token: string): { host: string; port: number; hasPort: boolean } {
  const raw = (token || '').trim();
  const [h, p] = raw.split(':').map(s => s.trim());
  const port = p ? Number(p) || DEFAULT_NET_PORT : DEFAULT_NET_PORT;
  return { host: h, port, hasPort: !!p };
}
function normalizeHost(h: any) { return String(h || '').trim(); }
function normalizePort(p: any) {
  const n = typeof p === 'number' ? p : Number(p);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NET_PORT;
}

// Robust match: if token has port, require exact host+port.
// If token has no port, match any saved printer with same host (prefer 9100).
function findSavedByIpToken(ipToken: string, list: NetPrinterProfile[]): NetPrinterProfile | null {
  const { host: tHost, port: tPort, hasPort } = parseIpToken(ipToken);
  if (!tHost) return null;
  const scored: Array<{ score: number; prof: NetPrinterProfile }> = [];

  for (const prof of list || []) {
    const pHost = normalizeHost(prof.host);
    const pPort = normalizePort((prof as any).port);
    if (!pHost) continue;

    if (hasPort) {
      if (pHost === tHost && pPort === tPort) scored.push({ score: 100, prof });
    } else {
      if (pHost === tHost) scored.push({ score: pPort === DEFAULT_NET_PORT ? 55 : 50, prof });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].prof;
}

// Multi-IP tolerant extractor for kitchen
function getKitchenIpsFromBlock(k: any): string[] {
  const keys = ['ip_address', 'Ip_address', 'IP_ADDRESS', 'ipAddress', 'IpAddress'];
  const vals:any[]=[];
  for (const x of keys) if (k?.[x] != null) vals.push(k[x]);
  for (const x of keys) if (k?.data?.[x] != null) vals.push(k.data[x]);

  const out:string[]=[];
  for (const v of vals) {
    if (Array.isArray(v)) {
      v.forEach(s => { if (typeof s === 'string' && s.trim()) out.push(s.trim()); });
    } else if (typeof v === 'string') {
      v.split(',').forEach(p => { const q = p.trim(); if (q) out.push(q); });
    }
  }
  return Array.from(new Set(out));
}

// extract ip targets from your JSON (first kitchen only — used by legacy paths)
function extractIpTargets(payload: any) {
  const settingBlock = (payload?.data || []).find((b: any) => b?.type === 'setting');
  const cashierIps = asStrArray(get(settingBlock, 'data.ip_address', undefined));
  const kitchenBlock = (payload?.data || []).find((b: any) => b?.type === 'kitchen_print');
  const kitchenIps = kitchenBlock ? getKitchenIpsFromBlock(kitchenBlock) : [];
  const individual = String(kitchenBlock?.individual_print ?? '0') === '1';
  return { cashierIps, kitchenIps, individual, kitchenBlock };
}

// build kitchen-only payloads
function buildKitchenPayload(payload: any, kitchenBlock: any) {
  const clone = { ...payload };
  clone.data = [kitchenBlock];
  return clone;
}
function buildSingleKitchenItemPayload(payload: any, kitchenBlock: any, item: any) {
  const single = JSON.parse(JSON.stringify(kitchenBlock));
  single.data = { ...(single.data || {}), itemdata: [item] };
  const clone = { ...payload, data: [single] };
  return clone;
}

// ---- NEW: explicit type to fix "k implicitly has 'any'" ----
type KitchenEntry = {
  block: any;
  ips: string[];
  individual: boolean;
  idx: number;
};

export default function DrawerContent(_props: DrawerContentComponentProps) {
  const [busy, setBusy] = useState(false);
  const [activeTransport, setActiveTransport] = useState<'ble' | 'lan' | null>(null);

  // BLE
  const [bleList, setBleList] = useState<any[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bleDevice, setBleDevice] = useState<{ name: string; mac: string } | null>(null);
  const [bleConnected, setBleConnected] = useState(false);

  // legacy single-LAN
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9100');
  const [lanConnected, setLanConnected] = useState(false);

  // multi-LAN
  const [enableMultiNet, setEnableMultiNetUI] = useState(false);
  const [savedPrinters, setSavedPrinters] = useState<NetPrinterProfile[]>([]);

  // Add printer modal
  const [addModal, setAddModal] = useState(false);
  const [newIp, setNewIp] = useState('');
  const [newPort, setNewPort] = useState('9100');

  // Edit printer modal
  const [editModal, setEditModal] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editIp, setEditIp] = useState('');
  const [editPort, setEditPort] = useState('9100');

  const triedBleOnce = useRef(false);
  const triedNetOnce = useRef(false);

  const ble = useMemo(() => new BLEPrinterService(), []);
  const lan = useMemo(() => new NetPrinterService(), []);

  // ---- CHANGE: add a tiny print queue to serialize all prints ----
  const printChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueuePrint = (job: () => Promise<void>) => {
    const next = printChainRef.current
      .then(job)
      .catch(() => {})   // keep chain alive on error
      .then(() => {});
    printChainRef.current = next;
    return next;
  };

  // ---------- BLE ----------
  const openDevicePicker = async () => {
    try {
      setBusy(true);
      if (!(await ensureBtPerms())) {
        Alert.alert('Permission required', 'Enable Bluetooth & Location permissions.');
        return;
      }
      const list = await RNBluetoothClassic.getBondedDevices();
      if (!list?.length) {
        Alert.alert('No devices', 'Pair your printer in Android Bluetooth settings first.');
        return;
      }
      setBleList(list);
      setPickerVisible(true);
    } catch (e) {
      Alert.alert('Bluetooth', errMsg(e) || 'Failed to list devices.');
    } finally {
      setBusy(false);
    }
  };
  const selectDevice = (d: any) => {
    setBleDevice({ name: d.name || d.device_name || 'Printer', mac: d.address });
    setPickerVisible(false);
  };
  const connectBluetooth = async () => {
    if (!bleDevice) return Alert.alert('Select Device', 'Please select a Bluetooth printer.');
    try {
      setBusy(true);
      await ble.init();
      await ble.connect(bleDevice.mac);
      setBleConnected(true);
      setActiveTransport('ble');
      await writePrefs({ btAddress: bleDevice.mac, btName: bleDevice.name });
      await mirrorPrefsToPublic();
      Alert.alert('Bluetooth', 'Connected.');
    } catch (e) {
      Alert.alert('Bluetooth', errMsg(e) || 'Failed to connect.');
    } finally {
      setBusy(false);
    }
  };
  const printReceiptBle = async () => {
    await enqueuePrint(async () => {
      if (!bleDevice?.mac) return Alert.alert('Select Device', 'Choose a Bluetooth printer first.');
      try {
        setBusy(true);
        if (!(await ensureBtPerms())) {
          Alert.alert('Bluetooth', 'Bluetooth permissions are required.');
          return;
        }
        try { await ble.disconnect?.(); } catch {}
        const session = new BLEPrinterService();
        await session.init();
        await session.connect(bleDevice.mac);

        // === CHANGE: Bluetooth should NOT print kitchen_print blocks ===
        const nonKitchenJson = {
          ...(receiptJson as any),
          data: ((receiptJson as any)?.data || []).filter(
            (b: any) => String(b?.type).toLowerCase() !== 'kitchen_print'
          ),
        };
        // ===============================================================

        try {
          await renderReceipt(nonKitchenJson as any, session, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
        } catch {
          try { await session.disconnect?.(); } catch {}
          const session2 = new BLEPrinterService();
          await session2.init();
          await session2.connect(bleDevice.mac);
          await renderReceipt(nonKitchenJson as any, session2, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          try { await session2.disconnect?.(); } catch {}
        }
        await sleep(150);
        try { await session.disconnect?.(); } catch {}
        setBleConnected(true);
      } catch (e) {
        Alert.alert('Print', errMsg(e) || 'Failed to print receipt.');
      } finally {
        setBusy(false);
      }
    });
  };

  // -------------- MULTI-LAN CORE --------------
  async function printToSingleNetProfile(profile: NetPrinterProfile, payload: any, tag: string) {
    const host = profile.host;
    const port = (typeof profile.port === 'number' && profile.port > 0) ? profile.port : DEFAULT_NET_PORT;
    const widthDots = (profile.widthDots === 384 || profile.widthDots === 576) ? profile.widthDots : DEFAULT_WIDTH_DOTS;

    await appendLog(`${tag} [saved-route] connect ${host}:${port} (widthDots=${widthDots})`);
    await lan.init();
    await lan.connect({ host, port });

    try {
      await renderReceipt(payload, lan, { widthDots, logoScale: LOGO_SCALE });
      await appendLog(`${tag} [saved-route] printed to ${host}:${port}`);
    } catch (e) {
      await appendLog(`${tag} [saved-route] first try failed, retrying once: ${errMsg(e)}`);
      await lan.init();
      await lan.connect({ host, port });
      await renderReceipt(payload, lan, { widthDots, logoScale: LOGO_SCALE });
      await appendLog(`${tag} [saved-route] printed (retry) to ${host}:${port}`);
    }
    await sleep(150);
    await lan.disconnect?.();
  }

  // ***** FIXED: print ALL kitchen_print blocks (with types to satisfy TS) *****
  async function handleMultiLanPrint(json: any, tag: string): Promise<{ handled: boolean; matched: boolean }> {
    // Cashier IPs from setting block
    const settingBlock = (json?.data || []).find((b: any) => b?.type === 'setting');
    const cashierIps = asStrArray(get(settingBlock, 'data.ip_address', undefined));

    // ALL kitchen_print blocks
    const kitchenBlocks = (json?.data || []).filter((b: any) => b?.type === 'kitchen_print') as any[];

    const kitchenEntries: KitchenEntry[] = kitchenBlocks.map(
      (block: any, idx: number): KitchenEntry => ({
        block,
        ips: getKitchenIpsFromBlock(block),
        individual: String(block?.individual_print ?? '0') === '1',
        idx,
      })
    );

    await appendLog(
      `${tag} parsed cashierIps=[${cashierIps.join(', ')}], ` +
      `kitchenBlocks=${kitchenEntries.length} (${kitchenEntries
        .map((k: KitchenEntry) => `#${k.idx}[${k.ips.join(', ')}]`)
        .join('; ')})`
    );

    const hasAnyKitchenIp = kitchenEntries.some((k: KitchenEntry) => k.ips.length > 0);
    if (cashierIps.length === 0 && !hasAnyKitchenIp) {
      await appendLog(`${tag} [saved-route] no ip_address found in JSON; not handled`);
      return { handled: false, matched: false };
    }

    const list = savedPrinters;
    try { await appendLog(`${tag} savedPrinters: ${list.map(p => `${p.host}:${normalizePort((p as any).port)}`).join(', ')}`); } catch {}

    const targets: Array<{
      profile: NetPrinterProfile;
      type: 'cashier' | 'kitchen';
      blockIdx?: number;
      item?: any;
    }> = [];

    // Cashier (full receipt) targets
    for (const ip of cashierIps) {
      const prof = findSavedByIpToken(ip, list);
      await appendLog(`${tag} cashier target token="${ip}" -> ${prof ? `match ${prof.host}:${normalizePort((prof as any).port)}` : 'no match'}`);
      if (prof) targets.push({ profile: prof, type: 'cashier' });
    }

    // Kitchen targets for EVERY kitchen_print block
    for (const entry of kitchenEntries) {
      const { block, ips, individual, idx } = entry;
      if (ips.length === 0) continue;

      for (const ip of ips) {
        const prof = findSavedByIpToken(ip, list);
        await appendLog(`${tag} kitchen#${idx} target token="${ip}" -> ${prof ? `match ${prof.host}:${normalizePort((prof as any).port)}` : 'no match'}`);
        if (!prof) continue;

        if (individual) {
          const items = (block?.data?.itemdata || []) as any[];
          for (const it of items) targets.push({ profile: prof, type: 'kitchen', blockIdx: idx, item: it });
        } else {
          targets.push({ profile: prof, type: 'kitchen', blockIdx: idx });
        }
      }
    }

    if (targets.length === 0) {
      await appendLog(`${tag} [saved-route] no saved printer matched any ip_address token`);
      return { handled: true, matched: false };
    }

    // Dedupe by host:port + type + blockIdx + item identity
    const seen = new Set<string>();
    const uniqueTargets = targets.filter(t => {
      const host = t.profile.host;
      const port = (t.profile.port || DEFAULT_NET_PORT);
      const itemKey = t.item ? `${t.item.item_name || ''}#${t.item.display_index || ''}` : '';
      const key = `${host}:${port}|${t.type}|b${t.blockIdx ?? -1}|${itemKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    await appendLog(`${tag} [saved-route] ${uniqueTargets.length} target(s) after dedupe`);

    // Execute prints
    for (const t of uniqueTargets) {
      const copies = (typeof (t.profile as any).copies === 'number' && (t.profile as any).copies > 0) ? (t.profile as any).copies : 1;
      const label = t.type === 'cashier'
        ? 'cashier/full'
        : (t.item ? `kitchen#${t.blockIdx} (per-item)` : `kitchen#${t.blockIdx} (group)`);

      await appendLog(`${tag} [saved-route] -> ${label} to ${t.profile.host}:${(t.profile.port || DEFAULT_NET_PORT)} (copies=${copies})`);

      if (t.type === 'cashier') {
        for (let i = 0; i < copies; i++) {
          await printToSingleNetProfile(t.profile, json, tag);
        }
      } else {
        const block = kitchenBlocks[t.blockIdx ?? 0];
        if (!block) continue;

        const payload = t.item
          ? buildSingleKitchenItemPayload(json, block, t.item)
          : buildKitchenPayload(json, block);

        for (let i = 0; i < copies; i++) {
          await printToSingleNetProfile(t.profile, payload, tag);
        }
      }
    }

    return { handled: true, matched: true };
  }

  // ---------- Legacy single-LAN connect/print ----------
  const connectNetwork = async () => {
    if (!host) return Alert.alert('IP required', 'Enter the printer IP (e.g. 192.168.0.100).');
    try {
      setBusy(true);
      const p = Number(port) || 9100;
      await lan.init();
      await lan.connect({ host, port: p });
      try { await lan.printText('NET OK\n', {} as any); } catch {}
      setLanConnected(true);
      setActiveTransport('lan');
      await writePrefs({ ip: host.trim(), port: p });
      await mirrorPrefsToPublic();
      Alert.alert('Network', `Connected to ${host}:${p}`);

      // Print Kitchen ticket(s) automatically on connect (kept from your last request)
      try {
        const tag = '[CONNECT][NET]';
        if (enableMultiNet && savedPrinters.length > 0) {
          await appendLog(`${tag} attempting saved-printer routing on connect`);
          const res = await handleMultiLanPrint(receiptJson as any, tag);
          if (res.handled) { await appendLog(`${tag} saved-printer routing completed (matched=${res.matched})`); return; }
          await appendLog(`${tag} no ip_address targeting in JSON -> fallback to legacy single-host kitchen print`);
        }
        const kb = (receiptJson as any)?.data?.find((b: any) => b?.type === 'kitchen_print');
        if (kb) {
          const individual = String(kb?.individual_print ?? '0') === '1';
          if (individual) {
            const items = kb?.data?.itemdata || [];
            for (const it of items) {
              const payload = buildSingleKitchenItemPayload(receiptJson as any, kb, it);
              await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
              await sleep(120);
            }
          } else {
            const payload = buildKitchenPayload(receiptJson as any, kb);
            await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          }
        }
      } catch (e) {
        Alert.alert('Kitchen Print', errMsg(e) || 'Failed to print kitchen receipt.');
      }

    } catch (e) {
      setLanConnected(false);
      if (activeTransport === 'lan') setActiveTransport(null);
      Alert.alert('Network', errMsg(e) || 'Failed to connect.');
    } finally {
      setBusy(false);
    }
  };
  const disconnectNetwork = async () => {
    try {
      setBusy(true);
      await lan.disconnect?.();
    } catch {}
    finally {
      setBusy(false);
      setLanConnected(false);
      if (activeTransport === 'lan') setActiveTransport(null);
    }
  };

  // ---------- Network "Print Demo" (NOW prints Kitchen-only) ----------
  const printReceiptLan = async () => {
    await enqueuePrint(async () => {
      const tag = '[DEMO][NET-KITCHEN]';
      try {
        setBusy(true);

        // Build a kitchen-only view of the JSON so only kitchen routes print
        const allBlocks = (receiptJson as any)?.data || [];
        const kitchenBlocks = allBlocks.filter((b: any) => b?.type === 'kitchen_print');
        if (!kitchenBlocks.length) {
          Alert.alert('Kitchen Print', 'No kitchen_print block found in receipt JSON.');
          return;
        }
        const kitchenOnlyJson = { ...(receiptJson as any), data: kitchenBlocks };

        if (enableMultiNet && savedPrinters.length > 0) {
          await appendLog(`${tag} attempting saved-printer routing for kitchen-only JSON`);
          const res = await handleMultiLanPrint(kitchenOnlyJson, tag);
          if (res.handled) {
            if (res.matched) {
              await appendLog(`${tag} printed to matched kitchen target(s)`);
              setLanConnected(true);
            } else {
              await appendLog(`${tag} no saved printer matched -> fallback to legacy single-LAN kitchen print`);
              // fall through to legacy
            }
          } else {
            await appendLog(`${tag} kitchen-only JSON had no ip targets -> legacy single-LAN kitchen print`);
            // fall through to legacy
          }
        }

        // Legacy single-host kitchen print (connected IP)
        const legacyHost = host.trim();
        const legacyPort = Number(port) || 9100;
        if (!legacyHost) {
          await appendLog(`${tag} legacy fallback aborted: no IP set`);
          Alert.alert('Network', 'No legacy IP set to print kitchen receipt.');
          return;
        }

        await appendLog(`${tag} [legacy] connect ${legacyHost}:${legacyPort}`);
        await lan.init();
        await lan.connect({ host: legacyHost, port: legacyPort });

        // Print all kitchen blocks; respect individual_print
        for (const kb of kitchenBlocks) {
          const individual = String(kb?.individual_print ?? '0') === '1';
          if (individual) {
            const items = kb?.data?.itemdata || [];
            for (const it of items) {
              const payload = buildSingleKitchenItemPayload(receiptJson as any, kb, it);
              await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
              await sleep(120);
            }
          } else {
            const payload = buildKitchenPayload(receiptJson as any, kb);
            await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          }
        }

        setLanConnected(true);
      } catch (e) {
        await appendLog(`${tag} ERROR: ${errMsg(e)}`);
        Alert.alert('Print', errMsg(e) || 'Failed to print kitchen receipt over network.');
      } finally {
        setBusy(false);
      }
    });
  };

  // ---------- Boot ----------
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (cancelled) return;
      const prefs = await readPrefs();
      const multi = await getEnableMultiNet();
      const printers = await getNetPrinters();
      setEnableMultiNetUI(!!multi);
      setSavedPrinters(printers);

      if (prefs.ip) { setHost(prefs.ip); setPort(String(prefs.port ?? 9100)); }
      if (prefs.btAddress) { setBleDevice({ name: prefs.btName || prefs.btAddress, mac: prefs.btAddress }); }

      if (prefs.ip && !lanConnected && !triedNetOnce.current) {
        triedNetOnce.current = true;
        try {
          await lan.init();
          await lan.connect({ host: prefs.ip, port: prefs.port || 9100 });
          setLanConnected(true);
          setActiveTransport((t) => t ?? 'lan');
        } catch {}
      }
      if (prefs.btAddress && !bleConnected && !triedBleOnce.current) {
        triedBleOnce.current = true;
        if (!(await ensureBtPerms())) return;
        try {
          await ble.init();
          await ble.connect(prefs.btAddress);
          setBleConnected(true);
          setActiveTransport((t) => t ?? 'ble');
        } catch {}
      }
    };
    boot();
    return () => { cancelled = true; };
  }, []);

  // ---------- AppState refresh ----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      const prefs = await readPrefs();
      const multi = await getEnableMultiNet();
      const printers = await getNetPrinters();
      setEnableMultiNetUI(!!multi);
      setSavedPrinters(printers);

      if (prefs.ip && !lanConnected && !triedNetOnce.current) {
        triedNetOnce.current = true;
        try {
          await lan.init();
          await lan.connect({ host: prefs.ip, port: prefs.port || 9100 });
          setLanConnected(true);
          setActiveTransport((t) => t ?? 'lan');
        } catch {}
      }
      if (prefs.btAddress && !bleConnected && !triedBleOnce.current) {
        triedBleOnce.current = true;
        if (!(await ensureBtPerms())) return;
        try {
          await ble.init();
          await ble.connect(prefs.btAddress);
          setBleConnected(true);
          setActiveTransport((t) => t ?? 'ble');
        } catch {}
      }
    });
    return () => sub.remove();
  }, [bleConnected, lanConnected]);

  // ---------- PRINT_JSON router ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PRINT_JSON', async (json) => {
      await enqueuePrint(async () => {
        const tag = '[EVENT]';
        try {
          // ----------------- STRICT WEBVIEW ROUTER (ADDED) -----------------
          // Split payload once for strict routing
          const allBlocks = ((json as any)?.data || []) as any[];
          const cashierPayload = { ...(json as any), data: allBlocks.filter(b => String(b?.type).toLowerCase() !== 'kitchen_print') };
          const kitchenOnlyJson = { ...(json as any), data: allBlocks.filter(b => String(b?.type).toLowerCase() === 'kitchen_print') };

          let didSomething = false;

          // CASHIER -> BLE ONLY
          if (bleConnected && bleDevice?.mac && cashierPayload.data.length) {
            if (!(await ensureBtPerms())) {
              Alert.alert('Bluetooth', 'Bluetooth permissions are required.');
            } else {
              try { await ble.disconnect?.(); } catch {}
              const session = new BLEPrinterService();
              await session.init();
              await session.connect(bleDevice.mac);
              try {
                await renderReceipt(cashierPayload as any, session, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });

                try { await session.cut?.('full'); } catch {}
              } catch {
                try { await session.disconnect?.(); } catch {}
                const session2 = new BLEPrinterService();
                await session2.init();
                await session2.connect(bleDevice.mac);
                await renderReceipt(cashierPayload as any, session2, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
                try { await session2.cut?.('full'); } catch {}
                try { await session2.disconnect?.(); } catch {}
              }
              await sleep(150);
              try { await session.disconnect?.(); } catch {}
              setBleConnected(true);
              didSomething = true;
            }
          }

          // KITCHEN -> LAN ONLY (Multi-Network first; otherwise legacy LAN kitchen-only)
          if (kitchenOnlyJson.data.length) {
            if (enableMultiNet && savedPrinters.length > 0) {
              await appendLog(`${tag} strict: multi-LAN routing for kitchen only`);
              const res = await handleMultiLanPrint(kitchenOnlyJson, tag); // IMPORTANT: pass kitchen-only
              // STRICT: do NOT fall back to full JSON on LAN
              if (res.matched) didSomething = true;
            } else if (lanConnected && host) {
              const p = Number(port) || 9100;
              await appendLog(`${tag} strict: legacy LAN kitchen-only to ${host}:${p}`);
              await lan.init();
              await lan.connect({ host, port: p });
              try {
                for (const kb of kitchenOnlyJson.data) {
                  const individual = String(kb?.individual_print ?? '0') === '1';
                  if (individual) {
                    const items = kb?.data?.itemdata || [];
                    for (const it of items) {
                      const payload = buildSingleKitchenItemPayload(json as any, kb, it);
                      await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
                      await sleep(120);
                    }
                  } else {
                    const payload = buildKitchenPayload(json as any, kb);
                    await renderReceipt(payload, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
                  }
                }
                setLanConnected(true);
                didSomething = true;
              } finally {
                try { await lan.disconnect?.(); } catch {}
              }
            }
          }

          if (!didSomething) {
            await appendLog(`${tag} strict: nothing printed (need BLE for cashier and/or Multi-Network IP match for kitchen)`);
            Alert.alert('No eligible printer', 'Connect BLE for cashier and/or configure Multi-Network IP matches for kitchen.');
          }
          // ----------------- STRICT WEBVIEW ROUTER (ADDED END) -----------------


          // ----------------- ORIGINAL LOGIC (COMMENTED OUT) -----------------
          /*
          if (enableMultiNet && savedPrinters.length > 0) {
            await appendLog(`${tag} attempting saved-printer routing using ip_address in JSON`);
            const res = await handleMultiLanPrint(json, tag);
            if (res.handled) {
              if (res.matched) {
                await appendLog(`${tag} saved-printer routing: printed to matched target(s)`);
              } else {
                await appendLog(`${tag} saved-printer routing: no match -> blocking fallback (no print)`);
              }
              return;
            }
            await appendLog(`${tag} no ip_address targeting in JSON -> considering fallback`);
          }

          if (activeTransport === 'ble' && bleDevice?.mac) {
            if (!(await ensureBtPerms())) {
              Alert.alert('Bluetooth', 'Bluetooth permissions are required.');
              return;
            }
            try { await ble.disconnect?.(); } catch {}
            const session = new BLEPrinterService();
            await session.init();
            await session.connect(bleDevice.mac);

            const payload = {
              ...(json as any),
              data: ((json as any)?.data || []).filter(
                (b: any) => String(b?.type).toLowerCase() !== 'kitchen_print'
              ),
            };

            try {
              await renderReceipt(payload as any, session, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
            } catch {
              try { await session.disconnect?.(); } catch {}
              const session2 = new BLEPrinterService();
              await session2.init();
              await session2.connect(bleDevice.mac);
              await renderReceipt(payload as any, session2, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
              try { await session2.disconnect?.(); } catch {}
            }
            await sleep(150);
            try { await session.disconnect?.(); } catch {}
            setBleConnected(true);
            return;
          }

          // ❌ This is the fallback that printed FULL JSON to LAN.
          //    It has been replaced by the STRICT router above.
          if (activeTransport === 'lan' && host) {
            const p = Number(port) || 9100;
            await appendLog(`${tag} [default-route] event fallback to ${host}:${p}`);
            await lan.init();
            await lan.connect({ host, port: p });
            try {
              await renderReceipt(json as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
            } catch {
              await lan.init();
              await lan.connect({ host, port: p });
              await renderReceipt(json as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
            }
            setLanConnected(true);
            return;
          }

          await appendLog(`${tag} no transport connected — alerting user`);
          Alert.alert('No printer connected', 'Connect Bluetooth or Network printer first.');
          */
          // ----------------- ORIGINAL LOGIC (COMMENTED OUT END) -----------------

        } catch (err) {
          await appendLog(`${tag} ERROR: ${errMsg(err)}`);
          Alert.alert('Print error', errMsg(err));
        }
      });
    });
    return () => sub.remove?.();
  }, [activeTransport, bleConnected, lanConnected, host, port, bleDevice?.mac, enableMultiNet, savedPrinters]);

  // ---------- UI ----------
  return (
    <DrawerContentScrollView contentContainerStyle={styles.scroll}>
      {busy && <ActivityIndicator style={{ marginBottom: 12 }} />}

      {/* BLUETOOTH */}
      <Text style={styles.h1}>Bluetooth Printer</Text>
      <View style={styles.section}>
        <Text style={styles.label}>Select Device</Text>

        <TouchableOpacity style={styles.selectUnderline} onPress={openDevicePicker}>
          <Text style={styles.selectText}>
            {bleDevice ? `${bleDevice.name} (${bleDevice.mac.slice(0, 8)}…)` : 'Choose a device'}
          </Text>
          <Text style={{ opacity: 0.6 }}>▾</Text>
        </TouchableOpacity>

        {bleConnected ? (
          <>
            <TouchableOpacity
              style={styles.pill}
              onPress={async () => {
                try { setBusy(true); await ble.disconnect?.(); } catch {}
                finally { setBusy(false); }
                setBleConnected(false);
                if (activeTransport === 'ble') setActiveTransport(null);
              }}
            >
              <Text style={styles.pillText}>Disconnect from Bluetooth</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.pill} onPress={printReceiptBle}>
              <Text style={styles.pillText}>Print Demo Text (Bluetooth)</Text>
            </TouchableOpacity>

            <Text style={styles.statusOk}>
              Status <Text style={{ fontWeight: '700' }}>Bluetooth connected</Text>
            </Text>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.pill, !bleDevice && styles.pillDisabled]}
              onPress={connectBluetooth}
              disabled={!bleDevice}
            >
              <Text style={[styles.pillText, !bleDevice && styles.pillTextDisabled]}>
                Connect to Bluetooth
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.pill, styles.pillDisabled]} disabled>
              <Text style={[styles.pillText, styles.pillTextDisabled]}>Print Demo Text (Bluetooth)</Text>
            </TouchableOpacity>

            <Text style={styles.statusMuted}>Status Not connected</Text>
          </>
        )}
      </View>

      {/* Divider */}
      <View style={styles.divider} />

      {/* NETWORK */}
      <Text style={[styles.h1, { marginTop: 8 }]}>Network Printer</Text>
      <View style={styles.section}>
        <Text style={styles.label}>IP Address</Text>
        <TextInput
          placeholder="192.168.1.104"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          style={styles.inputUnderline}
          placeholderTextColor="#9CA3AF"
        />

        <Text style={styles.label}>Port</Text>
        <TextInput
          placeholder="9100"
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
          style={styles.inputUnderline}
          placeholderTextColor="#9CA3AF"
        />

        {lanConnected ? (
          <>
            <TouchableOpacity style={styles.pill} onPress={printReceiptLan}>
              <Text style={styles.pillText}>Print Demo Text (Network)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.pill} onPress={disconnectNetwork}>
              <Text style={styles.pillText}>Disconnect Network</Text>
            </TouchableOpacity>

            <Text style={styles.statusOk}>
              Status <Text style={{ fontWeight: '700' }}>Connected</Text> to {host.trim()}:{(port || '9100').trim()}
            </Text>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.pill, !host && styles.pillDisabled]}
              onPress={connectNetwork}
              disabled={!host}
            >
              <Text style={[styles.pillText, !host && styles.pillTextDisabled]}>
                Connect to Network Printer
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.pill, styles.pillDisabled]} disabled>
              <Text style={[styles.pillText, styles.pillTextDisabled]}>
                Print Demo Text (Network)
              </Text>
            </TouchableOpacity>

            <Text style={styles.statusMuted}>Status Not connected</Text>
          </>
        )}
      </View>

      {/* Divider */}
      <View style={styles.divider} />

      {/* MULTI-LAN */}
      <Text style={[styles.h1, { marginTop: 8 }]}>Multi Network Printers</Text>
      <View style={styles.section}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Enable Multi-Network Printing</Text>
          <Switch value={enableMultiNet} onValueChange={async (v) => { setEnableMultiNetUI(v); await setEnableMultiNet(v); }} />
        </View>

        <View style={{ height: 8 }} />

        <TouchableOpacity
          style={[styles.pill, !enableMultiNet && styles.pillDisabled]}
          onPress={() => enableMultiNet ? setAddModal(true) : Alert.alert('Enable Multi-Network', 'Turn on the toggle first.')}
          disabled={!enableMultiNet}
        >
          <Text style={[styles.pillText, !enableMultiNet && styles.pillTextDisabled]}>
            + Add Network Printer
          </Text>
        </TouchableOpacity>

        {savedPrinters.length === 0 ? (
          <Text style={styles.statusMuted}>No saved network printers.</Text>
        ) : (
          <View>
            {savedPrinters.map((p, idx) => {
              const portShown = (typeof p.port === 'number' && p.port > 0) ? p.port : DEFAULT_NET_PORT;
              return (
                <View key={`${p.host}:${portShown}:${idx}`} style={styles.cardRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700', color: '#111827' }}>
                      {p.host}:{portShown}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={styles.btnMini}
                    onPress={() => {
                      setEditIndex(idx);
                      setEditIp(p.host || '');
                      setEditPort(String(portShown));
                      setEditModal(true);
                    }}
                  >
                    <Text style={styles.btnMiniText}>Edit</Text>
                  </TouchableOpacity>

                  <View style={{ width: 6 }} />
                  <TouchableOpacity
                    style={[styles.btnMini, { backgroundColor: '#FFF5F5', borderColor: '#FEE2E2' }]}
                    onPress={async () => {
                      Alert.alert('Delete', `Remove ${p.host}:${portShown}?`, [
                        { text: 'Cancel' },
                        {
                          text: 'Delete', style: 'destructive', onPress: async () => {
                            const next = savedPrinters.filter((x, i) => i !== idx);
                            setSavedPrinters(next);
                            await setNetPrinters(next);
                          }
                        },
                      ]);
                    }}
                  >
                    <Text style={[styles.btnMiniText, { color: RED }]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* BLE picker */}
      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={[styles.h1, { marginBottom: 8 }]}>Select Bluetooth Device</Text>
            <FlatList
              data={bleList}
              keyExtractor={(item, idx) => `${item?.address || idx}`}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.deviceRow} onPress={() => selectDevice(item)}>
                  <Text style={{ fontWeight: '600' }}>{item.name || item.device_name}</Text>
                  <Text style={{ opacity: 0.6 }}>{item.address}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text>No devices found</Text>}
              style={{ maxHeight: 320 }}
            />
            <TouchableOpacity style={[styles.pill, { marginTop: 12 }]} onPress={() => setPickerVisible(false)}>
              <Text style={styles.pillText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Add Network Printer */}
      <Modal visible={addModal} transparent animationType="fade" onRequestClose={() => setAddModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={[styles.h1, { marginBottom: 8 }]}>Add Network Printer</Text>

            <Text style={styles.label}>IP Address</Text>
            <TextInput
              placeholder="192.168.1.104"
              value={newIp}
              onChangeText={setNewIp}
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              style={styles.inputUnderline}
              placeholderTextColor="#9CA3AF"
            />

            <Text style={styles.label}>Port</Text>
            <TextInput
              placeholder="9100"
              value={newPort}
              onChangeText={setNewPort}
              keyboardType="number-pad"
              style={styles.inputUnderline}
              placeholderTextColor="#9CA3AF"
            />

            <View style={{ height: 12 }} />

            <View style={styles.rowBetween}>
              <TouchableOpacity
                style={[styles.pill, { flex: 1, marginRight: 8 }]}
                onPress={async () => {
                  const ip = newIp.trim();
                  if (!ip) return Alert.alert('Validation', 'Enter IP address (e.g., 192.168.1.104)');
                  const p = Number(newPort) || DEFAULT_NET_PORT;
                  const next = (() => {
                    const idx = savedPrinters.findIndex(x => x.host === ip && (x.port || DEFAULT_NET_PORT) === p);
                    const n = [...savedPrinters];
                    if (idx >= 0) n[idx] = { ...n[idx], host: ip, port: p };
                    else n.push({ name: ip, host: ip, port: p });
                    return n;
                  })();
                  setSavedPrinters(next);
                  await setNetPrinters(next);
                  setNewIp('');
                  setNewPort(String(DEFAULT_NET_PORT));
                  setAddModal(false);
                }}
              >
                <Text style={styles.pillText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.pill, { flex: 1 }]} onPress={() => setAddModal(false)}>
                <Text style={styles.pillText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Edit Network Printer */}
      <Modal visible={editModal} transparent animationType="fade" onRequestClose={() => setEditModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={[styles.h1, { marginBottom: 8 }]}>Edit Network Printer</Text>

            <Text style={styles.label}>IP Address</Text>
            <TextInput
              placeholder="192.168.1.104"
              value={editIp}
              onChangeText={setEditIp}
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              style={styles.inputUnderline}
              placeholderTextColor="#9CA3AF"
            />

          <Text style={styles.label}>Port</Text>
            <TextInput
              placeholder="9100"
              value={editPort}
              onChangeText={setEditPort}
              keyboardType="number-pad"
              style={styles.inputUnderline}
              placeholderTextColor="#9CA3AF"
            />

            <View style={{ height: 12 }} />

            <View style={styles.rowBetween}>
              <TouchableOpacity
                style={[styles.pill, { flex: 1, marginRight: 8 }]}
                onPress={async () => {
                  if (editIndex === null) return setEditModal(false);
                  const ip = editIp.trim();
                  if (!ip) return Alert.alert('Validation', 'Enter IP address (e.g., 192.168.1.104)');
                  const p = Number(editPort) || DEFAULT_NET_PORT;

                  const next = [...savedPrinters];
                  next[editIndex] = { ...next[editIndex], host: ip, port: p };
                  setSavedPrinters(next);
                  await setNetPrinters(next);

                  setEditModal(false);
                  setEditIndex(null);
                }}
              >
                <Text style={styles.pillText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pill, { flex: 1 }]}
                onPress={() => {
                  setEditModal(false);
                  setEditIndex(null);
                }}
              >
                <Text style={styles.pillText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </DrawerContentScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, backgroundColor: '#FAFAFA' },
  h1: { fontSize: 18, fontWeight: '700', marginBottom: 10, color: '#111827' },
  section: { paddingVertical: 6 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E5E7EB', marginVertical: 12 },
  label: { fontSize: 12, color: SUBTLE, marginBottom: 6 },
  selectUnderline: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BORDER, marginBottom: 16,
  },
  selectText: { fontSize: 14, color: '#111827' },
  inputUnderline: {
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BORDER,
    marginBottom: 16, fontSize: 14, color: '#111827', backgroundColor: 'transparent',
  },
  pill: {
    backgroundColor: '#F5F1FF', borderRadius: 26, paddingVertical: 12,
    alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: '#E2DAFF',
  },
  pillText: { color: PRIMARY, fontWeight: '700' },
  pillDisabled: { backgroundColor: DISABLED_BG, borderColor: '#E6E2F5' },
  pillTextDisabled: { color: DISABLED_TXT },
  statusOk: { marginTop: 6, color: '#111827' },
  statusMuted: { marginTop: 6, color: '#9CA3AF' },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center',
  },
  modalCard: { width: '86%', backgroundColor: '#fff', borderRadius: 16, padding: 16 },
  deviceRow: { paddingVertical: 10, borderBottomColor: '#EEE', borderBottomWidth: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: BORDER, borderRadius: 12,
    padding: 10, marginBottom: 10, backgroundColor: '#FFFFFF',
  },
  btnMini: {
    paddingVertical: 6, paddingHorizontal: 10,
    borderWidth: 1, borderColor: '#E2DAFF',
    borderRadius: 10, backgroundColor: '#F5F1FF',
  },
  btnMiniText: { color: PRIMARY, fontWeight: '700', fontSize: 12 },
});
