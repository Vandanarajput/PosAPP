// src/transports/blePrinter.ts
// @ts-nocheck
//
// BLE-first hybrid transport:
// - Use BLEPrinter for init/connect/printText/printImageBase64 (so logos print)
// - Try cut via BLE raw; if the printer ignores it, fall back to a short
//   Classic RFCOMM (SPP) send using react-native-bluetooth-classic just for the cut.
//
// Why: many printers silently ignore cutter opcodes over BLE, but accept them
// over RFCOMM. This hybrid approach preserves your logo printing and restores
// auto-cut on the same MAC.

import { BLEPrinter } from 'react-native-thermal-receipt-printer-image-qr';
import RNBluetoothClassic from 'react-native-bluetooth-classic';
import { Buffer } from 'buffer';
import type { PrinterTransport } from './types';

const hasFn = (o: any, k: string) => o && typeof o[k] === 'function';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class BLEPrinterService implements PrinterTransport {
  private mac: string | null = null;

  async init() {
    if (hasFn(BLEPrinter, 'init')) await BLEPrinter.init();
    // best-effort ensure BT is on (no-op if fails)
    try { await RNBluetoothClassic.isBluetoothEnabled?.(); } catch {}
  }

  async connect(mac: string) {
    console.log(`[BLE] Attempting to connect to printer: ${mac}`);
    if (!hasFn(BLEPrinter, 'connectPrinter')) {
      console.error('[BLE ERROR] connectPrinter() not available in this library build.');
      throw new Error('BLE connectPrinter() not available in this library build');
    }
    await BLEPrinter.connectPrinter(mac);
    this.mac = mac;
    console.log(`[BLE] Successfully connected to ${mac}`);
  }

  async disconnect() {
    if (hasFn(BLEPrinter, 'closeConn')) {
      try { await BLEPrinter.closeConn(); } catch (e) { console.warn('[BLE] closeConn err:', e); }
    }
    // Also best-effort close RFCOMM if it happens to be open
    try { if (this.mac) await RNBluetoothClassic.disconnectFromDevice?.(this.mac); } catch {}
    console.log('[BLE] Disconnected from printer.');
  }

  async printText(text: string, opts?: any) {
    if (!hasFn(BLEPrinter, 'printText')) {
      console.error('[BLE ERROR] printText() not available.');
      throw new Error('BLE printText() not available');
    }
    await BLEPrinter.printText(text, opts || {});
  }

  async printImageBase64(b64: string, opts?: { imageWidth?: number }) {
    if (!hasFn(BLEPrinter, 'printImageBase64')) {
      console.error('[BLE ERROR] printImageBase64() not available.');
      throw new Error('BLE printImageBase64() not available');
    }
    // Many firmwares require width to be divisible by 8
    const w = Math.max(8, (opts?.imageWidth ?? 0) & ~7);
    await BLEPrinter.printImageBase64(b64, { imageWidth: w });
  }

  /** ------- Raw helpers ------- */

  // Try to send raw over BLE (if this build supports printRawData)
  private async tryBleRaw(bytes: number[]): Promise<boolean> {
    const anyPrinter: any = BLEPrinter;
    if (!hasFn(anyPrinter, 'printRawData')) return false;

    // prefer base64 first
    try {
      const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64');
      await anyPrinter.printRawData(b64);
      return true;
    } catch {
      // fallback number[]
      try { await anyPrinter.printRawData(bytes); return true; } catch { return false; }
    }
  }

  // One-shot RFCOMM write: connect -> write -> small settle -> disconnect
  private async sendClassicOnce(bytes: number[]): Promise<boolean> {
    if (!this.mac) return false;
    let ok = false;
    try {
      // Connect secure first, then insecure fallback
      let conn = null;
      try {
        conn = await RNBluetoothClassic.connectToDevice(this.mac, { CONNECTOR_TYPE: 'rfcomm', secure: true });
      } catch {}
      if (!conn) {
        conn = await RNBluetoothClassic.connectToDevice(this.mac, { CONNECTOR_TYPE: 'rfcomm', secure: false });
      }
      if (!conn) throw new Error('RFCOMM connect failed');

      const bin = Buffer.from(Uint8Array.from(bytes));
      await RNBluetoothClassic.writeToDevice(this.mac, bin); // no encoding for Buffer
      ok = true;
      // tiny settle so the device acts on the command before we drop
      await sleep(60);
    } catch (e) {
      console.warn('[BLE->RFCOMM] sendClassicOnce error:', e);
    } finally {
      try { await RNBluetoothClassic.disconnectFromDevice?.(this.mac); } catch {}
    }
    return ok;
  }

  /** Public raw that tries BLE; no-throw if unsupported */
  async printRaw(bytes: number[]) {
    await this.tryBleRaw(bytes);
  }

  /**
   * Cut paper (default 'partial'). Strategy:
   *  1) Feed a few lines via BLE (ensures logo raster finishes & paper clears the platen)
   *  2) Try BLE raw cutter opcodes (some builds/printers ignore these)
   *  3) If no cut, try the SAME opcodes over a short RFCOMM session (usually works)
   */
  async cut(mode: 'full' | 'partial' = 'partial') {
    console.log('[BLE Cut] start', { mode });

    // 1) Feed (use ESC d 5 if possible; fallback newlines)
    const fed = await this.tryBleRaw([0x1B, 0x64, 0x05]); // ESC d 5
    if (!fed) {
      try { await BLEPrinter.printText('\n\n\n\n\n', {}); } catch {}
    }
    await sleep(40);

    // 2) Try common cutter sequences over BLE
    const wantFull = mode === 'full';
    const sequences: number[][] = [
      (wantFull ? [0x1D, 0x56, 0x00] : [0x1D, 0x56, 0x01]), // GS V m
      [0x1D, 0x56, 0x41, 0x00],                              // GS V 'A' n (some firmwares)
      [0x1D, 0x56, 0x42, 0x03],                              // GS V 'B' n (feed then cut)
      (wantFull ? [0x1B, 0x69] : [0x1B, 0x6D]),              // ESC i / ESC m
    ];

    for (const seq of sequences) {
      const ok = await this.tryBleRaw(seq);
      if (ok) {
        console.log('[BLE Cut] BLE raw sent', seq.map(b => '0x' + b.toString(16)).join(' '));
        // give it a moment; if your printer honors BLE cut, this is enough
        await sleep(80);
        return; // assume success; avoids double-cut risk
      }
    }

    // 3) BLE ignored cutter -> try once via RFCOMM
    console.warn('[BLE Cut] BLE path ignored cutter; trying RFCOMM fallback once…');
    for (const seq of sequences) {
      const ok = await this.sendClassicOnce(seq);
      if (ok) {
        console.log('[BLE Cut] RFCOMM cut sent', seq.map(b => '0x' + b.toString(16)).join(' '));
        return;
      }
    }

    console.warn('[BLE Cut] no cut variant succeeded (printer may not have an auto-cutter)');
  }
}
