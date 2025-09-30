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

// ✅ CHANGED: use RN Bluetooth Classic for listing paired printers (Classic MAC)
import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { BLEPrinterService } from '../transports/blePrinter';
import { NetPrinterService } from '../transports/netPrinter';
import { renderReceipt } from '../services/receiptRenderer';
import receiptJson from '../assets/receipt.json';
import { readPrefs, writePrefs } from '../services/prefs';

// === LOGGING: import helpers ===
import { appendLog, mirrorPrefsToPublic } from '../services/logger';

const WIDTH_DOTS = 384;   // 58mm
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

  // Active transport: 'ble' | 'lan' | null
  const [activeTransport, setActiveTransport] = useState<'ble' | 'lan' | null>(null);

  // ---- Bluetooth state ----
  const [bleList, setBleList] = useState<any[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bleDevice, setBleDevice] = useState<{ name: string; mac: string } | null>(null);
  const [bleConnected, setBleConnected] = useState(false);

  // ---- Network state ----
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9100');
  const [lanConnected, setLanConnected] = useState(false);

  const triedBleOnce = useRef(false);
  const triedNetOnce = useRef(false);

  const ble = useMemo(() => new BLEPrinterService(), []);
  const lan = useMemo(() => new NetPrinterService(), []);

  // ---------- Bluetooth ----------
  const openDevicePicker = async () => {
    try {
      setBusy(true);
      await appendLog('[BLE] openDevicePicker() requested permissions & listing devices');
      if (!(await ensureBtPerms())) {
        await appendLog('[BLE] permissions denied');
        Alert.alert('Permission required', 'Enable Bluetooth & Location permissions.');
        return;
      }

      // ✅ CHANGED: list **Classic** bonded devices (with Classic `address`)
      const list = await RNBluetoothClassic.getBondedDevices();
      await appendLog(`[BLE] RNBC.getBondedDevices() -> count=${list?.length || 0}`);
      if (!list?.length) {
        Alert.alert('No devices', 'Pair your printer in Android Bluetooth settings first.');
        return;
      }
      setBleList(list);
      setPickerVisible(true);
    } catch (e: any) {
      await appendLog(`[BLE] openDevicePicker ERROR: ${e?.message || String(e)}`);
      Alert.alert('Bluetooth', e?.message || 'Failed to list devices.');
    } finally {
      setBusy(false);
    }
  };

  // ✅ CHANGED: use Classic `address` instead of BLE `inner_mac_address`
  const selectDevice = (d: any) => {
    setBleDevice({ name: d.name || d.device_name || 'Printer', mac: d.address });
    appendLog(`[BLE] selected device name="${d.name || d.device_name}" mac=${d.address}`);
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
      await mirrorPrefsToPublic(); // LOG: expose prefs copy
      await appendLog('[BLE] connected & prefs saved');
      Alert.alert('Bluetooth', 'Connected.');
    } catch (e: any) {
      await appendLog(`[BLE] connect ERROR: ${e?.message || String(e)}`);
      Alert.alert('Bluetooth', e?.message || 'Failed to connect.');
    } finally {
      setBusy(false);
    }
  };

  const printReceiptBle = async () => {
    if (!bleConnected) return Alert.alert('Connect first', 'Connect to Bluetooth printer first.');
    try {
      setBusy(true);
      await appendLog('[BLE] printReceipt START');
      await renderReceipt(receiptJson as any, ble, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
      await appendLog('[BLE] printReceipt DONE');
    } catch (e: any) {
      await appendLog(`[BLE] print ERROR: ${e?.message || String(e)}`);
      Alert.alert('Print', e?.message || 'Failed to print receipt.');
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

      // Connect
      await lan.connect({ host, port: p });

      // 🔹 Smoke-test print to be sure the socket is truly usable.
      try {
        await appendLog('[NET] smoke test "NET OK"');
        await lan.printText('NET OK\n', {} as any);
      } catch (e) {
        await appendLog(`[NET] smoke test FAILED: ${String(e)}`);
        throw new Error(`Connected, but cannot print. Check IP/port or firewall.\n${String(e)}`);
      }

      // If smoke-test succeeded, now mark connected & persist
      setLanConnected(true);
      setActiveTransport('lan');
      await writePrefs({ ip: host.trim(), port: p });
      await mirrorPrefsToPublic(); // LOG: expose prefs copy
      await appendLog('[NET] connected & prefs saved');
      Alert.alert('Network', `Connected to ${host}:${p}`);
    } catch (e: any) {
      await appendLog(`[NET] connect ERROR: ${e?.message || String(e)}`);
      setLanConnected(false);
      if (activeTransport === 'lan') setActiveTransport(null);
      Alert.alert('Network', e?.message || 'Failed to connect.');
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
    } catch (e: any) {
      await appendLog(`[NET] disconnect ERROR: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
      setLanConnected(false);
      if (activeTransport === 'lan') setActiveTransport(null);
    }
  };

  const printReceiptLan = async () => {
    if (!lanConnected) return Alert.alert('Connect first', 'Connect to the network printer first.');
    try {
      setBusy(true);
      await appendLog('[NET] printReceipt START');
      await renderReceipt(receiptJson as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
      await appendLog('[NET] printReceipt DONE');
    } catch (e: any) {
      await appendLog(`[NET] print ERROR: ${e?.message || String(e)}`);
      Alert.alert('Print', e?.message || 'Failed to print receipt.');
    } finally {
      setBusy(false);
    }
  };

  // ---------- Auto-prefill + one-time auto-reconnect on mount ----------
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      if (cancelled) return;

      const prefs = await readPrefs();
      await appendLog(`[BOOT] prefs loaded ip=${prefs?.ip || ''} port=${prefs?.port || ''} bt=${prefs?.btAddress || ''}`);

      if (prefs.ip) {
        setHost(prefs.ip);
        setPort(String(prefs.port ?? 9100));
      }
      if (prefs.btAddress) {
        setBleDevice({ name: prefs.btName || prefs.btAddress, mac: prefs.btAddress });
      }

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
          } catch (e: any) {
            await appendLog(`[BOOT] NET smoketest fail: ${e?.message || String(e)}`);
          }
        } catch (e: any) {
          await appendLog(`[BOOT] NET reconnect ERROR: ${e?.message || String(e)}`);
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
        } catch (e: any) {
          await appendLog(`[BOOT] BLE reconnect ERROR: ${e?.message || String(e)}`);
        }
      }
    };

    boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Retry once when app comes to foreground ----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;

      await appendLog('[APPSTATE] became active; try one-time reconnects if pending');

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
          } catch (e: any) {
            await appendLog(`[APPSTATE] NET smoketest fail: ${e?.message || String(e)}`);
          }
        } catch (e: any) {
          await appendLog(`[APPSTATE] NET reconnect ERROR: ${e?.message || String(e)}`);
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
        } catch (e: any) {
          await appendLog(`[APPSTATE] BLE reconnect ERROR: ${e?.message || String(e)}`);
        }
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bleConnected, lanConnected]);

  // ---------- Listen for PRINT_JSON from WebView ----------
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('PRINT_JSON', async (json) => {
      try {
        await appendLog(`[EVENT] PRINT_JSON received (active=${activeTransport})`);
        if (activeTransport === 'ble' && bleConnected) {
          await appendLog('[EVENT] route to BLE transport');
          await renderReceipt(json as any, ble, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
        } else if (activeTransport === 'lan' && lanConnected) {
          await appendLog('[EVENT] route to NET transport');
          await renderReceipt(json as any, lan, { widthDots: WIDTH_DOTS, logoScale: LOGO_SCALE });
        } else {
          await appendLog('[EVENT] no transport connected — alerting user');
          Alert.alert('No printer connected', 'Connect Bluetooth or Network printer first.');
        }
      } catch (err: any) {
        await appendLog(`[EVENT] PRINT_JSON ERROR: ${err?.message || String(err)}`);
        Alert.alert('Print error', err?.message || String(err));
      }
    });
    return () => sub.remove?.();
  }, [activeTransport, bleConnected, lanConnected]);

  // ---------- UI ----------
  return (
    <DrawerContentScrollView contentContainerStyle={styles.scroll}>
      {busy && <ActivityIndicator style={{ marginBottom: 12 }} />}

      {/* BLUETOOTH */}
      <Text style={styles.h1}>Bluetooth Printer</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Select Device</Text>
        <TouchableOpacity style={styles.select} onPress={openDevicePicker}>
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
              <Text style={styles.pillText}>Print Receipt (Bluetooth)</Text>
            </TouchableOpacity>

            <Text style={{ marginTop: 8, color: '#059669' }}>Connected</Text>
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
              <Text style={[styles.pillText, styles.pillTextDisabled]}>Print Receipt (Bluetooth)</Text>
            </TouchableOpacity>

            <Text style={{ marginTop: 8, color: '#9CA3AF' }}>Not connected</Text>
          </>
        )}
      </View>

      {/* NETWORK */}
      <Text style={[styles.h1, { marginTop: 16 }]}>Network Printer</Text>
      <View style={styles.card}>
        <Text style={styles.label}>IP Address</Text>
        <TextInput
          placeholder="192.168.0.100"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          style={styles.input}
        />

        <Text style={styles.label}>Port</Text>
        <TextInput
          placeholder="9100"
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
          style={styles.input}
        />

        {lanConnected ? (
          <>
            <TouchableOpacity style={styles.pill} onPress={printReceiptLan}>
              <Text style={styles.pillText}>Print Receipt (Network)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.pill} onPress={disconnectNetwork}>
              <Text style={styles.pillText}>Disconnect Network</Text>
            </TouchableOpacity>

            <Text style={{ marginTop: 8, color: '#059669' }}>
              Connected to {host.trim()}:{(port || '9100').trim()}
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
                Print Receipt (Network)
              </Text>
            </TouchableOpacity>

            <Text style={{ marginTop: 8, color: '#9CA3AF' }}>Not connected</Text>
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
              // ✅ CHANGED: key uses Classic address
              keyExtractor={(item, idx) => `${item?.address || idx}`}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.deviceRow} onPress={() => selectDevice(item)}>
                  <Text style={{ fontWeight: '600' }}>{item.name || item.device_name}</Text>
                  {/* ✅ CHANGED: show Classic `address` */}
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
  scroll: { padding: 16 },
  h1: { fontSize: 20, fontWeight: '700', marginBottom: 10 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: BORDER,
  },

  label: { fontSize: 12, color: SUBTLE, marginBottom: 6 },

  select: {
    borderWidth: 1, borderColor: BORDER, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
    backgroundColor: '#FAFAFA',
  },
  selectText: { fontSize: 14 },

  input: {
    borderWidth: 1, borderColor: BORDER, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, marginBottom: 12,
    backgroundColor: '#FAFAFA', fontSize: 14,
  },

  pill: {
    backgroundColor: '#F5F1FF',
    borderRadius: 26,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2DAFF',
  },
  pillText: { color: PRIMARY, fontWeight: '700' },

  pillDisabled: { backgroundColor: DISABLED_BG, borderColor: '#E6E2F5' },
  pillTextDisabled: { color: DISABLED_TXT },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center',
  },
  modalCard: { width: '86%', backgroundColor: '#fff', borderRadius: 16, padding: 16 },
  deviceRow: { paddingVertical: 10, borderBottomColor: '#EEE', borderBottomWidth: 1 },
});
