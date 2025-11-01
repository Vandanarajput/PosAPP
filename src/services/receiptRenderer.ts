// src/services/receiptRenderer.ts
// Order-driven receipt renderer (logo → header → item → bigsummary → summary → footer → separator)

import type { PrinterTransport } from '../transports/types';
import { fetchLogoBase64ForPrinter } from './image';
import { COMMANDS } from 'react-native-thermal-receipt-printer-image-qr';

// ESC/POS align tokens from lib
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
      } else {
        line = w;
      }
    }
  }
  if (line) out.push(line);
  return out;
}

const rpad = (s: string, len: number) =>
  (s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length));
const lpad = (s: string, len: number) =>
  (s.length >= len ? s.slice(s.length - len) : ' '.repeat(len - s.length) + s);

const formatMoney = (n: number) => (Number.isFinite(n) ? n : 0).toFixed(2);
const rAlign = (s: string, width: number) => lpad(s, width);

function computeCols(total: number) {
  // Item | Qty | Price | Amount (fixed widths for last 3; Item takes the rest)
  const qty = 4;
  const price = 7;
  const amount = 8;
  const gaps = 3; // 3 spaces between cols + one safety
  const item = Math.max(8, total - (qty + price + amount + gaps));
  return { item, qty, price, amount };
}

const ITEM_NAME_WRAP = 30;

// totals aligned to the same "Amount" column
const AMOUNT_GAP = 1; // <<< CHANGED: match single-space gap before Amount column used in item rows
function amountAlignedRow(label: string, value: string | number, width: number) {
  const cols = computeCols(width);
  const gap = AMOUNT_GAP;
  const leftW = Math.max(1, width - cols.amount - gap);
  const labelText = String(label ?? '');
  const valueText = String(value ?? '');
  return rpad(labelText, leftW) + ' '.repeat(gap) + rAlign(valueText, cols.amount);
}

// inline-center each non-empty line by adding CENTER token
function centerBlock(text: string) {
  return text
    .split('\n')
    .map((l) => (l ? `${CENTER}${l}` : ''))
    .join('\n');
}

// ---------- device state ----------
// <<< CHANGED: accept widthDots so we can set *margins* and *printable width* to span the paper
async function saneState(t: PrinterTransport, widthDots?: number) {
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

  // --- HARD LEFT + FULL PRINT WIDTH (reduces left/right blank margins) ---
  // Many 80mm/58mm ESC/POS printers honor GS L / GS W for printable area.
  // Left margin = 0; Print area width = widthDots (clamped).
  // <<< ADDED: margin/width programming for full width text
  try {
    const wd = Math.max(384, Math.min(832, Number(widthDots || 576))); // safety clamp
    const marginDots = 12;                       // <<< CHANGED: small global margin (~1 char) on each side
    const left = marginDots;                     // <<< CHANGED
    const area = Math.max(64, wd - marginDots * 2); // <<< CHANGED: printable width after margins
    // GS L nL nH (left margin)
    await t.printRaw([0x1d, 0x57, area & 0xff, (area >> 8) & 0xff]);
    // GS W nL nH (print area width)
    await t.printRaw([0x1d, 0x4c, left & 0xff, (left >> 8) & 0xff]);
    // Force left justification for upcoming text
    await t.printRaw([0x1b, 0x61, 0x00]); // ESC a 0
  } catch (e) {
    console.log(`${TAG} saneState: margin/width program skipped`, e);
  }
  // -----------------------------------------------------------------------

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
// NOTE: You asked for dynamic width without changing JSON.
// <<< ADDED: helper that derives a sensible default from widthDots when JSON omits/low-balls it.
function bestCharsPerLine(widthDots: number, json: ReceiptJSON) {
  const setting = json?.data?.find((b) => b.type === 'setting')?.data ?? {};
  const fromJson = toInt(json?.item_length ?? setting.item_length, 0);
  if (fromJson > 0) return clamp(fromJson, 24, 64);
  // ESC/POS Font A is ~12 dots wide → chars ≈ dots/12
  const byDots = Math.round((widthDots || 576) / 12);
  return clamp(byDots, 24, 64);
}

function getCharWidth(json: ReceiptJSON) {
  const setting = json?.data?.find((b) => b.type === 'setting')?.data ?? {};
  const w = toInt(json?.item_length ?? setting.item_length, 35); // 58mm ~32–38; 80mm ~48–56
  return clamp(w, 24, 64);
}

// ================= MAIN (order-driven, uses if/else per block) =================
export async function renderReceipt(
  receiptJson: ReceiptJSON,
  transport: PrinterTransport,
  opts: RenderOptions
) {
  const TAG = '[receipt]';
  const { widthDots, logoScale = 0.55 } = opts;

  const marginDots = 12;                                                     // <<< CHANGED: must match saneState
  const effectiveDots = Math.max(64, (widthDots || 576) - marginDots * 2);   // <<< CHANGED

  // <<< CHANGED: compute characters-per-line from dots AFTER margins
  const width = bestCharsPerLine(effectiveDots, receiptJson);                // <<< CHANGED

  // <<< CHANGED: same total characters as item table; use everywhere we need to align under Amount
  const fullChars = Math.round((effectiveDots || 576) / 12); // <<< CHANGED

  // <<< CHANGED: software left margin wrapper
  const SOFT_MARGIN_CH = 2; // <<< CHANGED: small left margin (characters). Adjust 1–3.
  const padLines = (text: string) => { // <<< CHANGED
    const pad = ' '.repeat(SOFT_MARGIN_CH); // <<< CHANGED
    return String(text).split('\n').map((l) => { // <<< CHANGED
      if (!l) return l; // <<< CHANGED
      if (l.startsWith(CENTER)) return CENTER + pad + l.slice(CENTER.length); // <<< CHANGED
      if (l.startsWith(RIGHT))  return RIGHT  + pad + l.slice(RIGHT.length);  // <<< CHANGED
      if (l.startsWith(LEFT))   return LEFT   + pad + l.slice(LEFT.length);   // <<< CHANGED
      return pad + l; // <<< CHANGED
    }).join('\n'); // <<< CHANGED
  }; // <<< CHANGED
  const pt = async (s: string, o?: any) => transport.printText(padLines(s), o); // <<< CHANGED

  // <<< CHANGED: program printer state with margins using widthDots
  await saneState(transport, widthDots);

  // CHANGED: removed global "start centered" to avoid sticky center on some printers
  // await transport.printText('', { align: 'center' } as any);

  for (const block of receiptJson.data || []) {
    const type = String(block?.type ?? '').toLowerCase().trim();
    const data = block?.data ?? {};

    // --- LOGO ---
    if (type === 'logo') {
      const logoUrl: string | null = data?.url || null;
      if (logoUrl) {
        try {
          const { base64, widthDots: imgW } = await fetchLogoBase64ForPrinter(
            logoUrl,
            widthDots,
            logoScale ?? 0.55
          );
          const safeW = Math.max(8, Math.min(widthDots, imgW & ~7));
          const rawB64 = base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
          await transport.printImageBase64(rawB64, { imageWidth: safeW });
          await pt('\n\n'); // <<< CHANGED
        } catch (e) {
          console.log(`${TAG} logo: failed`, e);
        }
      }
    }

    // --- HEADER ---
    else if (type === 'header') {
      const title: string = data?.top_title ?? '';
      const subs: string[] = Array.isArray(data?.sub_titles) ? data.sub_titles : [];

      // Build one centered block (safer over BLE than multiple writes)
      const headerLines: string[] = [];
      if (title) headerLines.push(title);
      for (const s of subs) headerLines.push(String(s ?? '').trim());

      if (headerLines.length) {
        const block =
          headerLines.map(l => `${CENTER}${l}`).join('\n') + '\n';
        await pt(block, { bold: !!title }); // <<< CHANGED
      }

      await pt(LEFT); // <<< CHANGED
    }

    // --- SEPARATOR (print exactly where it appears in JSON) ---
    // --- SEPARATOR (print exactly where it appears in JSON) ---
    else if (type === 'separator') {
      const fullColsForSep = Math.round((effectiveDots || 576) / 12);
      await pt(LEFT + hr(fullColsForSep) + '\n'); // <<< CHANGED
      await pt(LEFT); // <<< CHANGED
    }

    // --- ITEM TABLE ---
    else if (type === 'item') {
      const items = Array.isArray(data?.itemdata) ? data.itemdata : [];

      // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      // Force the ITEMS table to use FULL printable width (after margins).
      const itemWidthFull = Math.round((effectiveDots || 576) / 12);
      const cols = computeCols(itemWidthFull);
      // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

      const buf: string[] = [];
      // table header
      buf.push(
        rpad('Item', cols.item) +
          ' ' +
          rAlign('Qty', cols.qty) +
          ' ' +
          rAlign('Price', cols.price) +
          ' ' +
          rAlign('Amount', cols.amount)
      );

      // rows
      for (const it of items) {
        const name = String(it.item_name ?? '');
        const qtyN = toInt(it.quantity, 1);
        const lineTotal = Number(it.item_amount ?? it.price ?? 0);
        const unitPrice = qtyN ? lineTotal / qtyN : lineTotal;

        const nameWrap = Math.min(cols.item, ITEM_NAME_WRAP);
        const lines = wrap(name, nameWrap);
        const first = lines.shift() || '';

        buf.push(
          rpad(first, cols.item) +
            ' ' +
            rAlign(String(qtyN), cols.qty) +
            ' ' +
            rAlign(formatMoney(unitPrice), cols.price) +
            ' ' +
            rAlign(formatMoney(lineTotal), cols.amount)
        );

        for (const tail of lines) {
          buf.push(
            rpad(tail, cols.item) +
              ' ' +
              ' '.repeat(cols.qty) +
              ' ' +
              ' '.repeat(cols.price) +
              ' ' +
              ' '.repeat(cols.amount)
          );
        }

        if (it.item_subLine) {
          for (const s of wrap(String(it.item_subLine), Math.max(4, cols.item - 2))) {
            buf.push(
              rpad('  ' + s, cols.item) +
                ' ' +
                ' '.repeat(cols.qty) +
                ' ' +
                ' '.repeat(cols.price) +
                ' ' +
                ' '.repeat(cols.amount)
            );
          }
        }
      }

      // DO NOT center the item table. Print left-aligned to fill full width.
      await pt(buf.join('\n') + '\n'); // <<< CHANGED
      await pt(LEFT); // <<< CHANGED
    }

    // --- KITCHEN PRINT (NEW) ---
    else if (type === 'kitchen_print') {
      const items = Array.isArray(data?.itemdata) ? data.itemdata : [];
      const lines: string[] = [];

      // Optional banner for clarity in the kitchen
      lines.push(`${CENTER}*** KITCHEN ***`);
      lines.push(hr(bestCharsPerLine(effectiveDots, { data: [] } as any)));

      for (const it of items) {
        const qtyN = toInt(it.quantity, 1);
        const name = String(it.item_name ?? '').trim();
        lines.push(rpad(`${qtyN} x ${name}`, bestCharsPerLine(effectiveDots, { data: [] } as any)));

        // toppings may come as "toppings" or "toppings_with_price"
        const toppingsArr: any[] = Array.isArray(it.toppings)
          ? it.toppings
          : Array.isArray(it.toppings_with_price)
          ? it.toppings_with_price
          : [];

        for (const t of toppingsArr) {
          lines.push(`  - ${String(t)}`);
        }

        if (it.print_description) {
          lines.push(`  ${String(it.print_description)}`);
        }

        lines.push(hr(bestCharsPerLine(effectiveDots, { data: [] } as any)));
      }

      await pt(lines.join('\n') + '\n'); // <<< CHANGED
      await pt(LEFT); // <<< CHANGED
    }

    // --- BIG SUMMARY (e.g., totals block) ---
    else if (type === 'bigsummary') {
      const rows = Array.isArray(data?.bigsummary) ? data.bigsummary : [];
      if (rows.length) {
        const lines: string[] = [];
        for (const r of rows) {
          lines.push(
            amountAlignedRow(
              String(r.key ?? ''),
              String(r.value ?? ''),
              fullChars // <<< CHANGED: align totals under the Amount column
            )
          );
        }
        await pt(lines.join('\n') + '\n'); // <<< CHANGED
        await pt(LEFT); // <<< CHANGED
      }
    }

    // --- SUMMARY (e.g., paid / change) ---
    else if (type === 'summary') {
      const rows = Array.isArray(data?.summary) ? data.summary : [];
      if (rows.length) {
        const lines: string[] = [];
        for (const r of rows) {
          lines.push(
            amountAlignedRow(
              String(r.key ?? ''),
              String(r.value ?? ''),
              fullChars // <<< CHANGED: align under Amount column
            )
          );
        }
        await pt(lines.join('\n') + '\n'); // <<< CHANGED
        await pt(LEFT); // <<< CHANGED
      }
    }

    // --- FOOTER (center block; align "key: value" within the line) ---
    else if (type === 'footer') {
      const align = String(data?.align ?? 'center').toLowerCase();
      const rawLines = Array.isArray(data?.footer_text) ? data.footer_text : [];
      if (rawLines.length) {
        const rows: string[] = [];
        for (const raw of rawLines) {
          const s = String(raw ?? '').trim();
          const idx = s.indexOf(':');
          if (idx > -1) {
            const key = s.slice(0, idx).trim();
            let val = s.slice(idx + 1).trim();
            val = val.replace(/^:+\s*/, '');                // <<< CHANGED: strip accidental leading colons
            rows.push(
              amountAlignedRow(
                `${key}:`,                                   // <<< CHANGED: always show exactly one colon after key
                `${val}`,
                fullChars
              )
            );
          } else {
            rows.push(rpad(s, fullChars));
          }
        }

        const text = rows.join('\n');

        if (align === 'right') {
          await pt(RIGHT + text + '\n'); // <<< CHANGED
        } else if (align === 'left') {
          await pt(LEFT + text + '\n'); // <<< CHANGED
        } else {
          await pt(centerBlock(text) + '\n'); // <<< CHANGED
        }
      }
      await pt(LEFT); // <<< CHANGED
    }

    // --- SETTING / OTHER TYPES (ignored for print) ---
    else {
      // noop
    }
  }

  // Optional thank-you (from JSON root or setting) — prints at the *very end*
  const thank =
    receiptJson?.thankYou ||
    (receiptJson?.data?.find((b) => b.type === 'setting')?.data?.thankyou_note as string) ||
    '';
  if (thank) {
    await pt(`${CENTER}${thank}\n`); // <<< CHANGED
    await pt(LEFT); // <<< CHANGED
  }

  // Cut
  if (typeof (transport as any).cut === 'function') await (transport as any).cut('full');
  else await autoCutSimple(transport);

  console.log(`${TAG} render done (logo → header → item → bigsummary → summary → footer → separator)`);
}
