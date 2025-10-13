// src/services/receiptRenderer.ts
// Faster, batched printing + transport-aware cut() at the end.

import type { PrinterTransport } from '../transports/types';
import { fetchLogoBase64ForPrinter } from './image';
import { COMMANDS } from 'react-native-thermal-receipt-printer-image-qr';

// Use TEXT_FORMAT tokens from the library
const CENTER = (COMMANDS as any).TEXT_FORMAT?.TXT_ALIGN_CT ?? '';
const LEFT   = (COMMANDS as any).TEXT_FORMAT?.TXT_ALIGN_LT ?? '';
const RIGHT  = (COMMANDS as any).TEXT_FORMAT?.TXT_ALIGN_RT ?? '';

export type RenderOptions = { widthDots: number; logoScale?: number };
export type ReceiptJSON = {
  item_length?: number | string;
  thankYou?: string;
  data: Array<{ type: string; data?: any; [k: string]: any }>;
};

// ---------- helpers ----------
const toInt = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const hr = (w: number) => '-'.repeat(clamp(w, 8, 64));

function wrap(text: string, width: number) {
  const words = String(text || '').split(' ');
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (test.length <= width) line = test;
    else {
      if (line) out.push(line);
      if (w.length > width) {
        for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
        line = '';
      } else line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

const rpad = (s: string, len: number) => (s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length));
const lpad = (s: string, len: number) => (s.length >= len ? s.slice(s.length - len) : ' '.repeat(len - s.length) + s);

// center-pad inside a fixed width (centers content INSIDE columns)
const cpad = (s: string, len: number) => {
  s = String(s ?? '');
  if (s.length >= len) return s.slice(0, len);
  const total = len - s.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
};

// numeric/decimal alignment helpers (right-aligned with 2 decimals)
const formatMoney = (n: number) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(2);
};
const rAlign = (s: string, width: number) => lpad(s, width);

function computeCols(total: number) {
  // Item | Qty | Price | Amount
  const qty = 4;
  const price = 7;
  const amount = 8;
  const gaps = 4;
  const item = Math.max(8, total - (qty + price + amount + gaps));
  return { item, qty, price, amount };
}

// limit for item-name wrap (keeps names on one line unless >30 chars)
const ITEM_NAME_WRAP = 30;

// ---------- totals aligned to the same "Amount" column ----------
const AMOUNT_GAP = 2;

function amountAlignedRow(label: string, value: string | number, width: number) {
  const cols = computeCols(width);
  const gap = AMOUNT_GAP;
  const leftW = Math.max(1, width - cols.amount - gap);
  const labelText = String(label ?? '');
  const valueText = String(value ?? '');
  return rpad(labelText, leftW) + ' '.repeat(gap) + rAlign(valueText, cols.amount);
}

// helper: center each non-empty line by inlining CENTER into the same string.
function centerBlock(text: string) {
  return text
    .split('\n')
    .map(l => (l ? `${CENTER}${l}` : ''))
    .join('\n');
}

// ---------- device state ----------
async function saneState(t: PrinterTransport) {
  const TAG = '[receipt]';
  if (!t.printRaw) {
    console.log(`${TAG} saneState: transport has no printRaw — skipping ESC/POS init`);
    return;
  }
  console.log(`${TAG} saneState: sending ESC/POS init`);
  await t.printRaw([0x1b, 0x40]);       // ESC @ init
  await t.printRaw([0x1b, 0x7b, 0x00]); // inverse off
  await t.printRaw([0x1b, 0x53]);       // standard
  await t.printRaw([0x1b, 0x32]);       // default line spacing
  await t.printRaw([0x1b, 0x72, 0x00]); // black
  await t.printRaw([0x1b, 0x74, 0x00]); // CP437
  console.log(`${TAG} saneState: done`);
}

/* ===================================================================
   Simple raw cut helper (fallback only)
=================================================================== */
async function autoCutSimple(p: { printRaw?: (b: number[]) => Promise<void> }) {
  const TAG = '[receipt]';
  console.log(`${TAG} cut: start`);
  if (p.printRaw) await p.printRaw([0x0a, 0x0a, 0x0a, 0x0a, 0x0a]); // feed 5x
  if (p.printRaw) await p.printRaw([0x1d, 0x56, 0x00]);             // GS V 0
  else console.log(`${TAG} cut: printRaw not available (skipping)`);
  console.log(`${TAG} cut: done`);
}

// ---------- config ----------
function getCharWidth(json: ReceiptJSON) {
  const setting = json?.data?.find(b => b.type === 'setting')?.data ?? {};
  const w = toInt(json?.item_length ?? setting.item_length, 35); // 58mm ~32–38; 80mm ~48–56
  return clamp(w, 24, 64);
}

// ---------- optional kitchen helpers ----------
function getKitchenBlockIfOnly(payload: ReceiptJSON) {
  if (!Array.isArray(payload?.data)) return null;
  if (payload.data.length !== 1) return null;
  const b = payload.data[0];
  return b?.type === 'kitchen_print' ? b : null;
}
function asKitchenItems(kb: any): any[] {
  const arr = kb?.data?.itemdata;
  return Array.isArray(arr) ? arr : [];
}
function asLines(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return [v.trim()].filter(Boolean);
  return [];
}

async function renderKitchenTicket(
  kitchenBlock: any,
  transport: PrinterTransport,
  width: number
) {
  const TAG = '[kitchen]';
  console.log(`${TAG} render start`);

  await transport.printText(`${CENTER}*** KITCHEN ***\n`, {} as any);

  const headerLines = asLines(kitchenBlock?.header_text);
  for (const ln of headerLines) await transport.printText(`${CENTER}${ln}\n`, {} as any);

  await transport.printText(LEFT, {} as any);
  await transport.printText(`${hr(width)}\n`, {} as any);

  const items = asKitchenItems(kitchenBlock);
  if (!items.length) {
    await transport.printText('(No items)\n', {} as any);
  } else {
    for (const it of items) {
      const qty = toInt(it?.quantity, 1);
      const name = String(it?.item_name ?? '').trim();
      const row = `${qty} x ${name}`;
      await transport.printText(`${row}\n`, { bold: true } as any);

      const tops = Array.isArray(it?.toppings) ? it.toppings : [];
      for (const t of tops) await transport.printText(`  • ${String(t)}\n`, {} as any);

      const cm = String(it?.custpmer_remarks ?? it?.customer_remarks ?? '').trim();
      if (cm) await transport.printText(`  Remarks: ${cm}\n`, {} as any);

      await transport.printText('\n', {} as any);
    }
  }

  await transport.printText(`${hr(width)}\n`, {} as any);
  await transport.printText(`${CENTER}— Ticket End —\n`, {} as any);

  if (typeof (transport as any).cut === 'function') await (transport as any).cut('full');
  else await autoCutSimple(transport);
  console.log(`${TAG} render done`);
}

// ================= MAIN (order-driven, honors "separator" blocks) ==============
export async function renderReceipt(
  receiptJson: ReceiptJSON,
  transport: PrinterTransport,
  opts: RenderOptions
) {
  await transport.printText('', { align: 'center' } as any);
  console.log('[renderReceipt] alignment=center set');

  const TAG = '[receipt]';
  const { widthDots, logoScale = 0.55 } = opts;
  const width = getCharWidth(receiptJson);

  // Kitchen-only fast path
  const kitchenOnly = getKitchenBlockIfOnly(receiptJson);
  if (kitchenOnly) {
    await saneState(transport);
    await renderKitchenTicket(kitchenOnly, transport, width);
    return;
  }

  // Thank-you (legacy)
  const thank =
    receiptJson?.thankYou ||
    (receiptJson?.data?.find(b => b.type === 'setting')?.data?.thankyou_note as string) ||
    '';

  await saneState(transport);

  // collect footers to print at the very end
  const deferredFooters: Array<{ align?: string; footer_text?: string[] }> = [];

  // Render blocks in JSON order, but DEFER footers
  for (const block of receiptJson.data || []) {
    // CHANGE: normalize type so Release builds don’t miss it due to casing/whitespace.
    const type = String(block?.type ?? '').toLowerCase().trim();
    const data = block?.data ?? {};

    switch (type) {
      case 'logo': {
        const logoUrl: string | null = data?.url || null;
        if (logoUrl) {
          try {
            const { base64, widthDots: imgW } = await fetchLogoBase64ForPrinter(logoUrl, widthDots, logoScale);
            const safeW = Math.max(8, Math.min(widthDots, imgW & ~7));
            const rawB64 = base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
            await transport.printImageBase64(rawB64, { imageWidth: safeW });
            await transport.printText('\n', {} as any);
          } catch (e) {
            console.log(`${TAG} logo: failed`, e);
          }
        }
        break;
      }

      case 'header': {
        const title: string = data?.top_title ?? '';
        const subs: string[] = data?.sub_titles ?? [];
        const lines: string[] = [];
        if (title) lines.push(title);
        for (const s of subs) lines.push(s);
        if (lines.length) {
          const centeredHeader = lines.map(l => `${CENTER}${l}`).join('\n') + '\n';
          await transport.printText(centeredHeader, { bold: !!title } as any);
        }
        await transport.printText(LEFT, {} as any);
        break;
      }

      case 'separator': {
        await transport.printText(`${CENTER}${hr(width)}\n`, {} as any);
        await transport.printText(LEFT, {} as any);
        break;
      }

      case 'item': {
        const items = Array.isArray(data?.itemdata) ? data.itemdata : [];
        const cols = computeCols(width);

        const buf: string[] = [];
        const head =
          rpad('Item',  cols.item)  + ' ' +
          rAlign('Qty', cols.qty)   + ' ' +
          rAlign('Price', cols.price) + ' ' +
          rAlign('Amount', cols.amount);
        buf.push(head);

        for (const it of items) {
          const name = String(it.item_name ?? '');
          const qtyN = toInt(it.quantity, 1);
          const lineTotal = Number(it.item_amount ?? it.price ?? 0);
          const unitPrice = qtyN ? lineTotal / qtyN : lineTotal;

          const nameWrap = Math.min(cols.item, ITEM_NAME_WRAP);
          const lines = wrap(name, nameWrap);
          const first = lines.shift() || '';

          buf.push(
            rpad(first, cols.item) + ' ' +
            rAlign(String(qtyN), cols.qty) + ' ' +
            rAlign(formatMoney(unitPrice), cols.price) + ' ' +
            rAlign(formatMoney(lineTotal), cols.amount)
          );

          for (const tail of lines) {
            buf.push(
              rpad(tail, cols.item) + ' ' +
              ' '.repeat(cols.qty)  + ' ' +
              ' '.repeat(cols.price)+ ' ' +
              ' '.repeat(cols.amount)
            );
          }

          if (it.item_subLine) {
            for (const s of wrap(String(it.item_subLine), Math.max(4, cols.item - 2))) {
              buf.push(
                rpad('  ' + s, cols.item) + ' ' +
                ' '.repeat(cols.qty)  + ' ' +
                ' '.repeat(cols.price)+ ' ' +
                ' '.repeat(cols.amount)
              );
            }
          }
        }

        await transport.printText(centerBlock(buf.join('\n')) + '\n', {} as any);
        await transport.printText(LEFT, {} as any);
        break;
      }

      case 'bigsummary': {
        const rows = Array.isArray(data?.bigsummary) ? data.bigsummary : [];
        if (rows.length) {
          const lines: string[] = [];
          for (const r of rows) {
            lines.push(amountAlignedRow(String(r.key ?? ''), String(r.value ?? ''), width));
          }
          await transport.printText(centerBlock(lines.join('\n')) + '\n', {} as any);
          await transport.printText(LEFT, {} as any);
        }
        break;
      }

      case 'summary': {
        const rows = Array.isArray(data?.summary) ? data.summary : [];
        if (rows.length) {
          const lines: string[] = [];
          for (const r of rows) {
            lines.push(amountAlignedRow(String(r.key ?? ''), String(r.value ?? ''), width));
          }
          await transport.printText(centerBlock(lines.join('\n')) + '\n', {} as any);
          await transport.printText(LEFT, {} as any);
        }
        break;
      }

      case 'footer': {
        deferredFooters.push({ align: data?.align, footer_text: data?.footer_text });
        break;
      }

      default: {
        // CHANGE: Release sometimes sends slightly different `type` values.
        // If a block *has* footer_text, treat it as footer anyway.
        if (data && Array.isArray(data.footer_text)) {
          deferredFooters.push({ align: data?.align, footer_text: data.footer_text });
        }
        break;
      }
    }
  }

  // compact, centered, key:value–aligned footer (printed ONCE, at the end)
  if (deferredFooters.length) {
    const allLines: string[] = deferredFooters.flatMap(ft => asLines(ft.footer_text));
    if (allLines.length) {
      const labelW = Math.min(18, Math.max(12, Math.floor(width * 0.45))); // tuned for 58mm
      const rows: string[] = [];
      for (const raw of allLines) {
        const idx = raw.indexOf(':');
        if (idx > -1) {
          const key = raw.slice(0, idx).trim();
          const val = raw.slice(idx + 1).trim();
          const left = rpad(`${key}:`, labelW);
          const pad  = Math.max(1, width - left.length - val.length);
          rows.push(left + ' '.repeat(pad) + val);
        } else {
          rows.push(rpad(raw, width));
        }
      }
      await transport.printText(centerBlock(rows.join('\n')) + '\n', {} as any);
      await transport.printText(LEFT, {} as any);
    }
  }

  // Thank-you (if present)
  if (thank) await transport.printText(`${CENTER}${thank}\n`);

  // Cut
  if (typeof (transport as any).cut === 'function') await (transport as any).cut('full');
  else await autoCutSimple(transport);

  console.log(`${TAG} render done`);
}
