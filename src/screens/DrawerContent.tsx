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
} from 'react-native';
import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer';

import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { BLEPrinterService } from '../transports/blePrinter';
import { NetPrinterService } from '../transports/netPrinter';
import { renderReceipt } from '../services/receiptRenderer';
import receiptJson from '../assets/receipt.json';
import { readPrefs, writePrefs } from '../services/prefs';
import { appendLog, mirrorPrefsToPublic } from '../services/logger';

// ---- helpers ----
function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
const sleep = (ms: number) => new Promise<void>(res => setTimeout(() => res(), ms));

const WIDTH_DOTS = 576; // NOTE: many 58mm printers are ~384 dots; verify your model
const LOGO_SCALE = 0.55;

// palette
const PRIMARY = '#6D28D9';
const BORDER = '#E5E7EB';
const SUBTLE = '#6B7280';
const DISABLED_BG = '#F1EFF9';
const DISABLED_TXT = '#8C7DB5';

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

export default function DrawerContent(_props: DrawerContentComponentProps) {
  const [busy, setBusy] = useState(false);
  const [activeTransport, setActiveTransport] = useState<'ble' | 'lan' | null>(null);

  // BLE UI state
  const [bleList, setBleList] = useState<any[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bleDevice, setBleDevice] = useState<{ name: string; mac: string } | null>(null);
  const [bleConnected, setBleConnected] = useState(false);

  // LAN state
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9100');
  const [lanConnected, setLanConnected] = useState(false);

  const triedBleOnce = useRef(false);
  const triedNetOnce = useRef(false);

  // Keep these as long-lived instances for “Connect/Disconnect” UI only.
  const ble = useMemo(() => new BLEPrinterService(), []);
  const lan = useMemo(() => new NetPrinterService(), []);

  // ---------- Bluetooth ----------
  const openDevicePicker = async () => {
    try {
      setBusy(true);
      await appendLog('[BLE] openDevicePicker: request perms & list devices');
      if (!(await ensureBtPerms())) {
        await appendLog('[BLE] permissions denied');
        Alert.alert('Permission required', 'Enable Bluetooth & Location permissions.');
        return;
      }
      const list = await RNBluetoothClassic.getBondedDevices();
      await appendLog(`[BLE] bonded devices = ${list?.length || 0}`);
      if (!list?.length) {
        Alert.alert('No devices', 'Pair your printer in Android Bluetooth settings first.');
        return;
      }
      setBleList(list);
      setPickerVisible(true);
    } catch (e) {
      await appendLog(`[BLE] openDevicePicker ERROR: ${errMsg(e)}`);
      Alert.alert('Bluetooth', errMsg(e) || 'Failed to list devices.');
    } finally {
      setBusy(false);
    }
  };

  const selectDevice = (d: any) => {
    setBleDevice({ name: d.name || d.device_name || 'Printer', mac: d.address });
    appendLog(`[BLE] selected ${d.name || d.device_name} (${d.address})`);
    setPickerVisible(false);
  };

  const connectBluetooth = async () => {
    if (!bleDevice) return Alert.alert('Select Device', 'Please select a Bluetooth printer.');
    try {
      setBusy(true);
      await appendLog(`[BLE] connect to ${bleDevice.name} (${bleDevice.mac})`);
      await ble.init();
      await ble.connect(bleDevice.mac);
      setBleConnected(true);
      setActiveTransport('ble');
      await writePrefs({ btAddress: bleDevice.mac, btName: bleDevice.name });
      await mirrorPrefsToPublic();
      await appendLog('[BLE] connected & prefs saved');
      Alert.alert('Bluetooth', 'Connected.');
    } catch (e) {
      await appendLog(`[BLE] connect ERROR: ${errMsg(e)}`);
      Alert.alert('Bluetooth', errMsg(e) || 'Failed to connect.');
    } finally {
      setBusy(false);
    }
  };

  // ---- BLE PRINT: fresh service per print to avoid stale sockets
  const printReceiptBle = async () => {
    if (!bleDevice?.mac) return Alert.alert('Select Device', 'Choose a Bluetooth printer first.');
    try {
      setBusy(true);
      await appendLog(`[BLE] printReceipt START -> fresh session for ${bleDevice.name} (${bleDevice.mac})`);

      if (!(await ensureBtPerms())) {
        await appendLog('[BLE] missing permissions at print time');
        Alert.alert('Bluetooth', 'Bluetooth permissions are required.');
        return;
      }

      // Best effort: close any previous lingering session on the long-lived instance
      try { await ble.disconnect?.(); } catch {}

      // Fresh per-print session
      const session = new BLEPrinterService();
      await session.init();
      await session.connect(bleDevice.mac);

      try {
        await renderReceipt(receiptJson as any, session, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
      } catch {
        await appendLog('[BLE] first print failed; recreate session & retry once');
        try { await session.disconnect?.(); } catch {}
        const session2 = new BLEPrinterService();
        await session2.init();
        await session2.connect(bleDevice.mac);
        await renderReceipt(receiptJson as any, session2, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
        try { await session2.disconnect?.(); } catch {}
      }

      await sleep(150); // let device flush
      try { await session.disconnect?.(); } catch {}

      await appendLog('[BLE] printReceipt DONE');
      setBleConnected(true);
    } catch (e) {
      await appendLog(`[BLE] print ERROR: ${errMsg(e)}`);
      Alert.alert('Print', errMsg(e) || 'Failed to print receipt.');
    } finally {
      setBusy(false);
    }
  };

  // ---------- Network ----------
  const connectNetwork = async () => {
    if (!host) return Alert.alert('IP required', 'Enter the printer IP (e.g. 192.168.0.100).');
    try {
      setBusy(true);
      const p = Number(port) || 9100;
      await appendLog(`[NET] connect to ${host}:${p}`);
      await lan.init();

      await lan.connect({ host, port: p });

      try {
        await appendLog('[NET] smoke test "NET OK"');
        await lan.printText('NET OK\n', {} as any);
      } catch (e) {
        await appendLog(`[NET] smoke test FAILED: ${errMsg(e)}`);
        throw new Error(`Connected, but cannot print. Check IP/port or firewall.\n${errMsg(e)}`);
      }

      setLanConnected(true);
      setActiveTransport('lan');
      await writePrefs({ ip: host.trim(), port: p });
      await mirrorPrefsToPublic();
      await appendLog('[NET] connected & prefs saved');
      Alert.alert('Network', `Connected to ${host}:${p}`);
    } catch (e) {
      await appendLog(`[NET] connect ERROR: ${errMsg(e)}`);
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
      await appendLog('[NET] disconnect requested');
      await lan.disconnect?.();
      await appendLog('[NET] disconnected');
    } catch (e) {
      await appendLog(`[NET] disconnect ERROR: ${errMsg(e)}`);
    } finally {
      setBusy(false);
      setLanConnected(false);
      if (activeTransport === 'lan') setActiveTransport(null);
    }
  };

  // ---- LAN PRINT: reconnect each job + retry once
  const printReceiptLan = async () => {
    if (!host) return Alert.alert('Connect first', 'Enter the printer IP address.');
    const p = Number(port) || 9100;

    try {
      setBusy(true);
      await appendLog(`[NET] printReceipt START -> reconnect ${host}:${p}`);

      await lan.init();
      await lan.connect({ host, port: p });

      try {
        await appendLog('[NET] smoke test "NET OK"');
        await lan.printText('NET OK\n', {} as any);
      } catch (e) {
        await appendLog(`[NET] smoke test failed (continuing): ${errMsg(e)}`);
      }

      try {
        await renderReceipt(receiptJson as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
      } catch (e) {
        await appendLog('[NET] first print failed; reconnect & retry once');
        await lan.init();
        await lan.connect({ host, port: p });
        await renderReceipt(receiptJson as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
      }

      await appendLog('[NET] printReceipt DONE');
      setLanConnected(true);
    } catch (e) {
      await appendLog(`[NET] print ERROR: ${errMsg(e)}`);
      Alert.alert('Print', errMsg(e) || 'Failed to print receipt over network.');
    } finally {
      setBusy(false);
    }
  };

  // ---------- Boot: prefill + one-time auto-reconnect ----------
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (cancelled) return;

      const prefs = await readPrefs();
      await appendLog(`[BOOT] prefs ip=${prefs?.ip || ''} port=${prefs?.port || ''} bt=${prefs?.btAddress || ''}`);

      if (prefs.ip) { setHost(prefs.ip); setPort(String(prefs.port ?? 9100)); }
      if (prefs.btAddress) { setBleDevice({ name: prefs.btName || prefs.btAddress, mac: prefs.btAddress }); }

      if (prefs.ip && !lanConnected && !triedNetOnce.current) {
        triedNetOnce.current = true;
        try {
          await appendLog('[BOOT] try auto NET reconnect');
          await lan.init();
          await lan.connect({ host: prefs.ip, port: prefs.port || 9100 });
          try {
            await lan.printText('NET OK\n', {} as any);
            setLanConnected(true);
            setActiveTransport((t) => t ?? 'lan');
            await appendLog('[BOOT] NET auto reconnect OK');
          } catch (e) {
            await appendLog(`[BOOT] NET smoketest fail: ${errMsg(e)}`);
          }
        } catch (e) {
          await appendLog(`[BOOT] NET reconnect ERROR: ${errMsg(e)}`);
        }
      }

      if (prefs.btAddress && !bleConnected && !triedBleOnce.current) {
        triedBleOnce.current = true;
        if (!(await ensureBtPerms())) return;
        try {
          await appendLog('[BOOT] try auto BLE reconnect');
          await ble.init();
          await ble.connect(prefs.btAddress);
          setBleConnected(true);
          setActiveTransport((t) => t ?? 'ble');
          await appendLog('[BOOT] BLE auto reconnect OK');
        } catch (e) {
          await appendLog(`[BOOT] BLE reconnect ERROR: ${errMsg(e)}`);
        }
      }
    };
    boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- AppState: one-time reconnect attempts ----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      await appendLog('[APPSTATE] active; try one-time reconnects');

      const prefs = await readPrefs();

      if (prefs.ip && !lanConnected && !triedNetOnce.current) {
        triedNetOnce.current = true;
        try {
          await appendLog('[APPSTATE] try NET reconnect');
          await lan.init();
          await lan.connect({ host: prefs.ip, port: prefs.port || 9100 });
          try {
            await lan.printText('NET OK\n', {} as any);
            setLanConnected(true);
            setActiveTransport((t) => t ?? 'lan');
            await appendLog('[APPSTATE] NET reconnect OK');
          } catch (e) {
            await appendLog(`[APPSTATE] NET smoketest fail: ${errMsg(e)}`);
          }
        } catch (e) {
          await appendLog(`[APPSTATE] NET reconnect ERROR: ${errMsg(e)}`);
        }
      }

      if (prefs.btAddress && !bleConnected && !triedBleOnce.current) {
        triedBleOnce.current = true;
        if (!(await ensureBtPerms())) return;
        try {
          await appendLog('[APPSTATE] try BLE reconnect');
          await ble.init();
          await ble.connect(prefs.btAddress);
          setBleConnected(true);
          setActiveTransport((t) => t ?? 'ble');
          await appendLog('[APPSTATE] BLE reconnect OK');
        } catch (e) {
          await appendLog(`[APPSTATE] BLE reconnect ERROR: ${errMsg(e)}`);
        }
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bleConnected, lanConnected]);

  // ---------- PRINT_JSON event routing ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PRINT_JSON', async (json) => {
      try {
        await appendLog(`[EVENT] PRINT_JSON (active=${activeTransport})`);
        if (activeTransport === 'ble' && bleDevice?.mac) {
          if (!(await ensureBtPerms())) {
            await appendLog('[EVENT][BLE] missing permissions');
            Alert.alert('Bluetooth', 'Bluetooth permissions are required.');
            return;
          }
          try { await ble.disconnect?.(); } catch {}

          const session = new BLEPrinterService();
          await session.init();
          await session.connect(bleDevice.mac);

          try {
            await renderReceipt(json as any, session, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          } catch (e) {
            await appendLog('[EVENT][BLE] first attempt failed; recreate session & retry once');
            try { await session.disconnect?.(); } catch {}
            const session2 = new BLEPrinterService();
            await session2.init();
            await session2.connect(bleDevice.mac);
            await renderReceipt(json as any, session2, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
            try { await session2.disconnect?.(); } catch {}
          }

          await sleep(150);
          try { await session.disconnect?.(); } catch {}
          setBleConnected(true);
        } else if (activeTransport === 'lan' && host) {
          const p = Number(port) || 9100;
          await lan.init();
          await lan.connect({ host, port: p });
          try {
            await renderReceipt(json as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          } catch (e) {
            await appendLog('[EVENT][NET] first attempt failed; reconnect & retry once');
            await lan.init();
            await lan.connect({ host, port: p });
            await renderReceipt(json as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
          }
          setLanConnected(true);
        } else {
          await appendLog('[EVENT] no transport connected — alerting user');
          Alert.alert('No printer connected', 'Connect Bluetooth or Network printer first.');
        }
      } catch (err) {
        await appendLog(`[EVENT] PRINT_JSON ERROR: ${errMsg(err)}`);
        Alert.alert('Print error', errMsg(err));
      }
    });
    return () => sub.remove?.();
  }, [activeTransport, bleConnected, lanConnected, host, port, bleDevice?.mac]);

  // ---------- UI ----------
  return (
    <DrawerContentScrollView contentContainerStyle={styles.scroll}>
      {busy && <ActivityIndicator style={{ marginBottom: 12 }} />}

      {/* BLUETOOTH */}
      <Text style={styles.h1}>Bluetooth Printer</Text>
      <View style={styles.section}>
        <Text style={styles.label}>Select Device</Text>

        {/* Underlined select (flat) */}
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
                try { setBusy(true); await appendLog('[BLE] manual disconnect'); await ble.disconnect?.(); } catch {}
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

      {/* Device picker modal */}
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
    </DrawerContentScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, backgroundColor: '#FAFAFA' },

  h1: { fontSize: 18, fontWeight: '700', marginBottom: 10, color: '#111827' },

  // flat section (no card box)
  section: {
    paddingVertical: 6,
  },

  // thin divider between sections
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E7EB',
    marginVertical: 12,
  },

  label: { fontSize: 12, color: SUBTLE, marginBottom: 6 },

  // underlined "select" (dropdown) field
  selectUnderline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    marginBottom: 16,
  },
  selectText: { fontSize: 14, color: '#111827' },

  // underlined inputs
  inputUnderline: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    marginBottom: 16,
    fontSize: 14,
    color: '#111827',
    backgroundColor: 'transparent',
  },

  // pills (kept)
  pill: {
    backgroundColor: '#F5F1FF',
    borderRadius: 26,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2DAFF',
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
});
