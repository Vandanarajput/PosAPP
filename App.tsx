// App.tsx
// @ts-nocheck
import 'react-native-gesture-handler';

import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import WebView from 'react-native-webview';

import DrawerContent from './src/screens/DrawerContent';
import { readPrefs, writePrefs } from './src/services/prefs';

// 🔹 NEW: logger (writes logs to Internal storage/Download/Techsapphire/app.log
// and mirrors prefs to Internal storage/Download/Techsapphire/printer_prefs.json)
import {
  hookConsoleToFile,
  mirrorPrefsToPublic,
  LOG_PATH,
  PREF_PUBLIC_PATH,
} from './src/services/logger';

// initialize logging & prefs mirroring once at module load
hookConsoleToFile();
mirrorPrefsToPublic();
console.log('Log file:', LOG_PATH);
console.log('Prefs copy:', PREF_PUBLIC_PATH);

const Drawer = createDrawerNavigator();
const { version: APP_VERSION } = require('./package.json');

// ---------------- Home (WebView host) ----------------
function HomeScreen({
  webUrl,
  onMessageFromWeb,
  refreshTick,
}: {
  webUrl: string;
  onMessageFromWeb: (e: any) => void;
  refreshTick: number;
}) {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(false);

  // Make window.messageHandler.postMessage available before page scripts run
  const injectedJS = `
    (function () {
      if (!window.messageHandler) {
        window.messageHandler = {
          postMessage: function (msg) {
            try { window.ReactNativeWebView.postMessage(msg); } catch (e) {}
          }
        };
      }
    })();
    true;
  `;

  // Force reload when user taps header refresh
  useEffect(() => {
    if (webRef.current && webUrl) {
      try { webRef.current.reload(); } catch {}
    }
  }, [refreshTick, webUrl]);

  if (!webUrl) {
    return <View style={{ flex: 1, backgroundColor: '#fff' }} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <WebView
        ref={webRef}
        source={{ uri: webUrl }}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        startInLoadingState
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        onMessage={onMessageFromWeb}
      />
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

// ---------------- App Shell ----------------
export default function App() {
  // URL modal state + persisted URL
  const [urlModalVisible, setUrlModalVisible] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [webUrl, setWebUrl] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Load saved URL on app start
  useEffect(() => {
    (async () => {
      try {
        const prefs = await readPrefs();
        if (prefs?.webUrl && typeof prefs.webUrl === 'string') {
          setWebUrl(prefs.webUrl);
          setUrlText(prefs.webUrl); // prefill the modal
        }
      } catch {}
    })();
  }, []);

  const openSearch = () => {
    // Optional: prefill modal with current page
    setUrlText(webUrl || urlText);
    setUrlModalVisible(true);
  };
  const onUrlCancel = () => setUrlModalVisible(false);
  const onUrlGo = async () => {
    let u = (urlText || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    setWebUrl(u);
    await writePrefs({ webUrl: u }); // persist URL
    setUrlModalVisible(false);
  };

  const doRefresh = () => setRefreshTick((n) => n + 1);
  const showInfo = () => Alert.alert('Techsapphire', `Version: ${APP_VERSION}`);

  // WebView → message → parse/resolve → emit PRINT_JSON
  const onMessageFromWeb = async (e: any) => {
    let raw = e?.nativeEvent?.data;
    if (!raw) return;

    try {
      // If page posts a trigger like: "esmartpos:...query..." or "tradywork:...query..."
      if (typeof raw === 'string' && (raw.startsWith('esmartpos:') || raw.startsWith('tradywork:'))) {
        const query = raw.split(':', 2)[1] || '';
        const url = `https://esmartpos.com/eprint/posprint.php/eprint?${query}`;
        const res = await fetch(url, { method: 'GET' });
        const txt = await res.text();
        let payload: any = txt;
        try { payload = JSON.parse(txt); } catch {}
        DeviceEventEmitter.emit('PRINT_JSON', payload); // DrawerContent listens and prints
        return;
      }

      // Otherwise expect direct JSON (may be double-encoded)
      let payload: any = raw;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); }
        catch {
          try {
            const fixed = payload.replace(/\\"/g, '"').replace(/\\n/g, '\n');
            payload = JSON.parse(fixed);
          } catch {
            try { payload = JSON.parse(JSON.parse(payload)); } catch {}
          }
        }
      }
      DeviceEventEmitter.emit('PRINT_JSON', payload);
    } catch (err: any) {
      Alert.alert('Print Error', err?.message || String(err));
    }
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationContainer>
        <Drawer.Navigator
          initialRouteName="Home"
          drawerContent={(props) => <DrawerContent {...props} />}
          screenOptions={({ navigation }) => ({
            headerTitle: 'Techsapphire',
            headerTitleAlign: 'left',
            headerTitleStyle: {
              fontSize: 22,
              fontWeight: Platform.select({ ios: '700', android: '700' }),
              color: '#252525',
            },
            headerStyle: {
              backgroundColor: '#FFF6FB',
              elevation: 0,
              shadowOpacity: 0,
              borderBottomWidth: 1,
              borderBottomColor: '#F0E3EE',
            },
            headerLeft: () => (
              <TouchableOpacity
                onPress={() => navigation.toggleDrawer()}
                style={{ paddingHorizontal: 14, paddingVertical: 6 }}
                accessibilityLabel="Open menu"
              >
                <View style={styles.burger} />
                <View style={[styles.burger, { width: 18, marginTop: 3 }]} />
                <View style={[styles.burger, { width: 22, marginTop: 3 }]} />
              </TouchableOpacity>
            ),
            headerRight: () => (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
                <TouchableOpacity onPress={openSearch} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                  <Text style={styles.navIcon}>🔍</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={doRefresh} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                  <Text style={styles.navIcon}>↻</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={showInfo} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                  <Text style={styles.navIcon}>ⓘ</Text>
                </TouchableOpacity>
              </View>
            ),
          })}
        >
          <Drawer.Screen name="Home">
            {() => (
              <HomeScreen
                webUrl={webUrl}
                refreshTick={refreshTick}
                onMessageFromWeb={onMessageFromWeb}
              />
            )}
          </Drawer.Screen>
        </Drawer.Navigator>
      </NavigationContainer>

      {/* Enter URL Modal */}
      <Modal
        visible={urlModalVisible}
        transparent
        animationType="fade"
        onRequestClose={onUrlCancel}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Enter URL</Text>
            <TextInput
              placeholder="https://your-site.com"
              value={urlText}
              onChangeText={setUrlText}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[styles.input, { color: '#111', backgroundColor: '#fff' }]}
              placeholderTextColor="#7A7A8A"
              selectionColor={Platform.select({ android: '#a79fbd', ios: '#a79fbd' })}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <TouchableOpacity onPress={onUrlCancel} style={styles.modalBtn}>
                <Text>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onUrlGo} style={[styles.modalBtn, styles.modalBtnPrimary]}>
                <Text style={{ color: '#fff' }}>Go</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loadingOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  burger: { width: 24, height: 2.2, backgroundColor: '#252525', borderRadius: 2 },
  navIcon: { fontSize: 20, color: '#252525' },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center',
    alignItems: 'center', padding: 16,
  },
  modalCard: {
    width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 12, padding: 16,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 12,
  },
  modalBtn: {
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', marginLeft: 10,
  },
  modalBtnPrimary: { backgroundColor: '#6D28D9', borderColor: '#6D28D9' },
});
