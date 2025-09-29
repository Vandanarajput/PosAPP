// src/transports/blePrinter.ts
// @ts-nocheck
import { BLEPrinter } from 'react-native-thermal-receipt-printer-image-qr';
import { Buffer } from 'buffer';
import type { PrinterTransport } from './types';

const hasFn = (obj: any, key: string) => obj && typeof obj[key] === 'function';

export class BLEPrinterService implements PrinterTransport {
  async init() {
    if (hasFn(BLEPrinter, 'init')) await BLEPrinter.init();
  }

  async connect(mac: string) {
    console.log(`[BLE] Attempting to connect to printer: ${mac}`);
    if (!hasFn(BLEPrinter, 'connectPrinter')) {
      console.error('[BLE ERROR] connectPrinter() not available in this library build.');
      throw new Error('BLE connectPrinter() not available in this library build');
    }
    await BLEPrinter.connectPrinter(mac);
    console.log(`[BLE] Successfully connected to ${mac}`);
  }

  async disconnect() {
    if (hasFn(BLEPrinter, 'closeConn')) {
      try {
        await BLEPrinter.closeConn();
        console.log('[BLE] Disconnected from printer.');
      } catch (e) {
        console.warn('[BLE] Error during disconnect (may be already closed):', e);
      }
    }
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
    await BLEPrinter.printImageBase64(b64, opts || {});
  }

  /**
   * Try to send raw bytes.
   * Returns true if sent, false if not supported by this library build.
   * (Slight tweak: try base64 first because many builds accept only base64.)
   */
  private async tryPrintRaw(bytes: number[]): Promise<boolean> {
    const anyPrinter: any = BLEPrinter;
    console.log(
      '[BLE tryPrintRaw] Attempting to send raw bytes:',
      bytes.map(b => '0x' + b.toString(16)).join(' ')
    );

    if (!hasFn(anyPrinter, 'printRawData')) {
      console.warn('[BLE tryPrintRaw] BLEPrinter.printRawData is NOT available in this library build.');
      return false;
    }

    // Prefer base64 first (most builds expect this)
    try {
      const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64');
      await anyPrinter.printRawData(b64);
      console.log('[BLE tryPrintRaw] Sent raw bytes as base64 successfully.');
      return true;
    } catch (eBase64) {
      console.warn('[BLE tryPrintRaw] Sending raw bytes as base64 failed:', eBase64);
      // Fallback: some forks accept number[]
      try {
        await anyPrinter.printRawData(bytes);
        console.log('[BLE tryPrintRaw] Sent raw bytes as number[] successfully.');
        return true;
      } catch (eArr) {
        console.warn('[BLE tryPrintRaw] Sending raw bytes as number[] failed:', eArr);
        return false;
      }
    }
  }

  /** Public raw helper that won’t throw if unsupported. */
  async printRaw(bytes: number[]) {
    await this.tryPrintRaw(bytes);
  }

  /**
   * Cut paper (default partial) with safe fallbacks.
   * If raw bytes aren’t supported by your BLE build AND no cutPaper(),
   * this will just feed and return (no crash).
   */
  async cut(mode: 'full' | 'partial' = 'partial') {
    console.log(`[BLE Cut] Attempting to cut paper (mode: ${mode})...`);

    // 1) Feed ~3 lines. Prefer ESC d n via raw; fall back to text.
    console.log('[BLE Cut] Step 1: Attempting to feed paper with ESC d 3...');
    const fed = await this.tryPrintRaw([0x1B, 0x64, 0x03]); // ESC d 3 (feed n lines)
    if (!fed && hasFn(BLEPrinter, 'printText')) {
      try {
        console.log('[BLE Cut] Raw feed failed, falling back to printText for feeding...');
        await BLEPrinter.printText('\n\n\n', {});
      } catch (e) {
        console.warn('[BLE Cut] printText feed fallback failed:', e);
      }
    } else if (fed) {
      console.log('[BLE Cut] Paper fed successfully with raw command.');
    }

    // 2) Library-native cutter if available.
    console.log('[BLE Cut] Step 2: Checking for native cutPaper()...');
    if (hasFn(BLEPrinter, 'cutPaper')) {
      try {
        console.log('[BLE Cut] native cutPaper() FOUND. Attempting to use it...');
        await BLEPrinter.cutPaper();
        console.log('[BLE Cut] native cutPaper() successful. Returning.');
        return;
      } catch (e) {
        console.warn('[BLE Cut] native cutPaper() FAILED:', e);
      }
    } else {
      console.log('[BLE Cut] native cutPaper() NOT available.');
    }

    // 3) ESC/POS cut bytes (only if raw is supported).
    console.log('[BLE Cut] Step 3: Trying common ESC/POS raw cut commands...');
    const wantFull = mode === 'full';

    // GS V 0/1 — full/partial cut
    const mainCutCmd = wantFull ? [0x1D, 0x56, 0x00] : [0x1D, 0x56, 0x01];
    console.log(`[BLE Cut] Trying GS V 0/1 (cmd: ${mainCutCmd.map(b => '0x' + b.toString(16)).join(' ')})...`);
    const triedMain = await this.tryPrintRaw(mainCutCmd);
    if (triedMain) {
      console.log('[BLE Cut] GS V 0/1 successful. Returning.');
      return;
    }

    // GS V 'B' n — feed then cut
    const altCutCmd = [0x1D, 0x56, 0x42, 0x03];
    console.log(`[BLE Cut] Trying GS V 'B' n (cmd: ${altCutCmd.map(b => '0x' + b.toString(16)).join(' ')})...`);
    const triedAlt = await this.tryPrintRaw(altCutCmd);
    if (triedAlt) {
      console.log('[BLE Cut] GS V B n successful. Returning.');
      return;
    }

    // ESC i / ESC m — full/partial cut
    const escICmd = wantFull ? [0x1B, 0x69] : [0x1B, 0x6D];
    console.log(`[BLE Cut] Trying ESC i/m (cmd: ${escICmd.map(b => '0x' + b.toString(16)).join(' ')})...`);
    await this.tryPrintRaw(escICmd);

    console.warn(
      `[BLE Cut] All attempts to cut paper failed using standard commands and library features.
       Your BLE build or printer might not support cutting, or require a different raw command.`
    );
  }
}
