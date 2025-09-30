// src/transports/netPrinter.ts
// @ts-nocheck
import { NetPrinter } from 'react-native-thermal-receipt-printer-image-qr';
import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import type { PrinterTransport } from './types';

const hasFn = (o: any, k: string) => o && typeof o[k] === 'function';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class NetPrinterService implements PrinterTransport {
  private _host: string | null = null;
  private _port: number = 9100;

  async init() {
    if (hasFn(NetPrinter, 'init')) await NetPrinter.init();
  }

  async connect(params: { host: string; port?: number }) {
    const port = params.port ?? 9100;
    this._host = params.host;
    this._port = port;

    console.log(`[NET] Attempting to connect to printer: ${params.host}:${port}`);
    if (!hasFn(NetPrinter, 'connectPrinter')) {
      console.log('[NET] connectPrinter() not available in this library build.');
      throw new Error('Net connectPrinter() not available in this library build');
    }
    await NetPrinter.connectPrinter(params.host, port);
    console.log(`[NET] Successfully connected to ${params.host}:${port}`);
  }

  async disconnect() {
    if (hasFn(NetPrinter, 'closeConn')) {
      try {
        await NetPrinter.closeConn();
        console.log('[NET] Disconnected from printer.');
      } catch (e) {
        console.log('[NET] closeConn error:', e);
      }
    }
  }

  async printText(text: string, opts?: any) {
    if (!hasFn(NetPrinter, 'printText')) {
      console.log('[NET] printText() not available.');
      throw new Error('Net printText() not available');
    }
    await NetPrinter.printText(text, opts || {});
  }

  async printImageBase64(b64: string, opts?: { imageWidth?: number }) {
    if (!hasFn(NetPrinter, 'printImageBase64')) {
      console.log('[NET] printImageBase64() not available.');
      throw new Error('Net printImageBase64() not available');
    }
    await NetPrinter.printImageBase64(b64, opts || {});
  }

  /**
   * SDK raw sender; it’s a safe no-op if unsupported.
   * Tries base64 first (most builds), then number[].
   */
  async printRaw(bytes: number[]) {
    const anyPrinter: any = NetPrinter;
    if (!hasFn(anyPrinter, 'printRawData')) {
      console.log('[NET printRaw] raw not supported by this build – skipping (no-op).');
      return;
    }
    try {
      const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64');
      await anyPrinter.printRawData(b64);
      console.log('[NET printRaw] sent as base64 ok');
    } catch (eBase64) {
      console.log('[NET printRaw] base64 path failed:', eBase64);
      try {
        await anyPrinter.printRawData(bytes);
        console.log('[NET printRaw] sent as number[] ok');
      } catch (eArr) {
        console.log('[NET printRaw] raw attempts failed; continuing without raw:', eArr);
      }
    }
  }

  /* ===== TCP helper: write raw bytes to the printer port (9100) ===== */
  private async sendTcpBytes(bytes: number[] | Uint8Array) {
    if (!this._host || !this._port) {
      console.log('[NET tcp] no host/port set; cannot send TCP bytes');
      return;
    }
    const buf = Buffer.from(bytes as any);

    await new Promise<void>((resolve, reject) => {
      let socket: any;
      try {
        socket = TcpSocket.createConnection(
          { host: this._host!, port: this._port, tls: false },
          () => {
            try {
              socket.write(buf);
              // tiny delay so data flushes before destroy
              setTimeout(() => {
                try { socket.destroy(); } catch {}
                resolve();
              }, 60);
            } catch (e) {
              try { socket.destroy(); } catch {}
              reject(e);
            }
          }
        );
        socket.on('error', (e: any) => { try { socket.destroy(); } catch {} reject(e); });
      } catch (e) {
        try { socket?.destroy?.(); } catch {}
        reject(e);
      }
    });
  }

  /**
   * ONE-FEED + ONE-CUT (immediate):
   * - close SDK socket first (lets the printer finalize the raster job now)
   * - send feed+cut over our own TCP connection (bypasses SDK queue)
   * - exactly one GS V opcode (0=full, 1=partial)
   */
  async cut(mode: 'full' | 'partial' = 'full') {
    console.log(`[NET Cut] start (mode: ${mode})`);

    // 0) Ask SDK to close its socket so the printer can accept a tiny new job immediately.
    try {
      await NetPrinter.closeConn?.();
      console.log('[NET Cut] SDK socket closed to flush job');
    } catch (e) {
      console.log('[NET Cut] SDK closeConn failed/ignored:', e);
    }

    // Small drain so the device flips from the SDK socket to idle.
    await sleep(80);

    // 1) FEED via direct TCP (do NOT go through SDK queue)
    try {
      await this.sendTcpBytes([0x0a, 0x0a, 0x0a, 0x0a, 0x0a]); // 5 x LF
    } catch (e) {
      console.log('[NET Cut] TCP feed failed (continuing):', e);
    }

    // 2) Exactly ONE standard ESC/POS GS V opcode over TCP
    const cmd = mode === 'partial' ? [0x1d, 0x56, 0x01] : [0x1d, 0x56, 0x00];
    console.log('[NET Cut] GS V send (TCP):', cmd.map(b => '0x' + b.toString(16)).join(' '));
    try {
      await this.sendTcpBytes(cmd);
    } catch (e) {
      console.log('[NET Cut] TCP cut failed:', e);
      // As a last resort, try SDK raw once (may be queued/delayed on some builds)
      try { await this.printRaw(cmd); } catch {}
    }

    console.log('[NET Cut] done');
  }
}
