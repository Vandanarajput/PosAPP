// src/transports/types.ts

export type Align = 'left' | 'center' | 'right';

export interface PrintTextOptions {
  align?: Align;      // 'left' | 'center' | 'right'
  bold?: boolean;     // if supported by the lib
  underline?: boolean;
}

export interface ImageOptions {
  // CHANGE: make optional to match transports (both accept optional imageWidth)
  imageWidth?: number; // printer dot width for the image
}

export interface NetConnectParams {
  host: string;
  port?: number;      // default 9100
}

// BLE connect uses MAC/address as a plain string
export type BleConnectParams = string;

export type ConnectParams = NetConnectParams | BleConnectParams;

export interface PrinterTransport {
  init(): Promise<void>;

  // BLE: pass MAC string; NET: pass {host, port?}
  connect(params: ConnectParams): Promise<void>;

  printText(text: string, opts?: PrintTextOptions): Promise<void>;

  printImageBase64(b64: string, opts: ImageOptions): Promise<void>;

  // Raw ESC/POS bytes (optional; some BLE builds don’t expose it)
  printRaw?(bytes: number[]): Promise<void>;

  /**
   * Ask the printer to cut.
   * CHANGE: Implementations should default to 'full' when mode is omitted
   * (matches the 2nd project behavior: feed 5 LFs then GS V 0).
   */
  cut?(mode?: 'full' | 'partial'): Promise<void>;

  disconnect?(): Promise<void>;
}
