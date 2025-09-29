// src/transports/netPrinter.ts
// @ts-nocheck
import { NetPrinter } from 'react-native-thermal-receipt-printer-image-qr';
import { Buffer } from 'buffer';
import type { PrinterTransport } from './types';

const hasFn = (o: any, k: string) => o && typeof o[k] === 'function';

export class NetPrinterService implements PrinterTransport {
  async init() {
    if (hasFn(NetPrinter, 'init')) await NetPrinter.init();
  }

  async connect(params: { host: string; port?: number }) {
    const port = params.port ?? 9100;
    console.log(`[NET] Attempting to connect to printer: ${params.host}:${port}`);
    if (!hasFn(NetPrinter, 'connectPrinter')) {
      console.error('[NET ERROR] connectPrinter() not available in this library build.');
      throw new Error('Net connectPrinter() not available in this library build');
    }
    await NetPrinter.connectPrinter(params.host, port);
    console.log(`[NET] Successfully connected to ${params.host}:${port}`);
  }

  async disconnect() {
    if (hasFn(NetPrinter, 'closeConn')) {
      try { await NetPrinter.closeConn(); } catch (e) { console.warn('[NET] closeConn error:', e); }
    }
  }

  async printText(text: string, opts?: any) {
    if (!hasFn(NetPrinter, 'printText')) throw new Error('Net printText() not available');
    await NetPrinter.printText(text, opts || {});
  }

  async printImageBase64(b64: string, opts?: { imageWidth?: number }) {
    if (!hasFn(NetPrinter, 'printImageBase64')) throw new Error('Net printImageBase64() not available');
    await NetPrinter.printImageBase64(b64, opts || {});
  }

  /**
   * SAFE raw sender:
   * - If this build doesn't have printRawData, DO NOT THROW (just log & return).
   * - Try base64 first, then number[].
   * This keeps printing working even when raw isn't supported.
   */
  async printRaw(bytes: number[]) {
    const anyPrinter: any = NetPrinter;
    if (!hasFn(anyPrinter, 'printRawData')) {
      console.log('[NET printRaw] raw not supported by this build – skipping (no-op).');
      return; // <-- IMPORTANT: no throw
    }

    try {
      const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64');
      await anyPrinter.printRawData(b64);
      return;
    } catch (eBase64) {
      try {
        await anyPrinter.printRawData(bytes);
        return;
      } catch (eArr) {
        // Even if both fail, DO NOT block the job; just log.
        console.warn('[NET printRaw] raw attempts failed; continuing without raw:', eArr);
      }
    }
  }

  /**
   * Cut (best-effort). If raw not supported and no native cutPaper(), this will just feed.
   */
  async cut(mode: 'full' | 'partial' = 'partial') {
    // Feed a bit so the tear line clears the platen
    try { await this.printRaw([0x1B, 0x64, 0x03]); } catch {}
    try { await NetPrinter.printText?.('\n\n\n', {}); } catch {}

    // Native cut if available
    if (hasFn(NetPrinter, 'cutPaper')) {
      try { await NetPrinter.cutPaper(); return; } catch (e) { console.warn('[NET cutPaper] failed:', e); }
    }

    // Raw ESC/POS fallbacks (silently skip if raw unsupported)
    const wantFull = mode === 'full';
    const tries = [
      wantFull ? [0x1D, 0x56, 0x00] : [0x1D, 0x56, 0x01], // GS V 0/1
      [0x1D, 0x56, 0x42, 0x03],                            // GS V 'B' 3
      wantFull ? [0x1B, 0x69] : [0x1B, 0x6D],              // ESC i/m
    ];
    for (const seq of tries) {
      try { await this.printRaw(seq); return; } catch {}
    }
    // If nothing worked, nothing else to do.
  }
}
