// src/services/receiptRenderer.ts
// Faster, batched printing + simple cut() call at the end.

import type { PrinterTransport } from '../transports/types';
import { fetchLogoBase64ForPrinter } from './image';

export type RenderOptions = { widthDots: number; logoScale?: number };
export type ReceiptJSON = {
  item_length?: number | string;
  thankYou?: string;
  data: Array<{ type: string; data: any }>;
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

// CHANGE: numeric/decimal alignment helpers (right-aligned with 2 decimals)
const formatMoney = (n: number) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(2);
};
const rAlign = (s: string, width: number) => lpad(s, width);

function twoCols(left: string, right: string, width: number) {
  const rightLen = right.length;
  const maxLeft = Math.max(0, width - rightLen - 1);
  let lt = left.slice(0, Math.max(0, maxLeft));
  if (left.length > maxLeft && maxLeft > 3) lt = left.slice(0, maxLeft - 3) + '...';
  const spaces = Math.max(1, width - lt.length - rightLen);
  return lt + ' '.repeat(spaces) + right;
}

function computeCols(total: number) {
  // Item | Qty | Price | Amount
  const qty = 4;
  const price = 7;
  const amount = 8;
  const gaps = 3;
  const item = Math.max(8, total - (qty + price + amount + gaps));
  return { item, qty, price, amount };
}

// ---------- device state (optional, only if raw supported) ----------
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

/* -------------------- NEW: cut fallback helper -------------------- */
async function cutWithFallback(
  p: { cut?: () => Promise<void>; printRaw?: (b: number[]) => Promise<void> }
) {
  const TAG = '[receipt]';
  console.log(`${TAG} cutWithFallback: start`);

  // Try the library cut first (NetPrinter.cutPaper / BLEPrinter.cutPaper, etc.)
  if (p.cut) {
    try {
      console.log(`${TAG} cutWithFallback: trying native cut()`);
      await p.cut();
      console.log(`${TAG} cutWithFallback: native cut() success`);
      return;
    } catch (e) {
      console.warn(`${TAG} cutWithFallback: native cut() failed`, e);
    }
  } else {
    console.log(`${TAG} cutWithFallback: native cut() not available on transport`);
  }

  // If no cut(), try raw ESC/POS sequences (Epson TM-m30 friendly)
  const tries: number[][] = [
    [0x1B, 0x69],           // ESC i  (full cut)
    [0x1B, 0x6D],           // ESC m  (partial cut)
    [0x1D, 0x56, 0x00],     // GS V 0 (full cut)
    [0x1D, 0x56, 0x01],     // GS V 1 (partial cut)
    [0x1D, 0x56, 0x42, 0x03]// GS V 'B' n (feed then cut)
  ];

  if (!p.printRaw) {
    console.log(`${TAG} cutWithFallback: printRaw not available; cannot send ESC/POS cut bytes`);
    return;
  }

  for (const seq of tries) {
    try {
      console.log(`${TAG} cutWithFallback: trying raw`, seq.map(b => '0x' + b.toString(16)).join(' '));
      await p.printRaw?.(seq);
      console.log(`${TAG} cutWithFallback: raw cut success`);
      return;
    } catch (e) {
      console.warn(`${TAG} cutWithFallback: raw cut attempt failed`, e);
    }
  }

  console.warn(`${TAG} cutWithFallback: all cut attempts failed (printer may not support cutter command)`);
}
/* ------------------ end NEW helper (only change #1) ---------------- */

// ---------- parse ----------
function parse(json: ReceiptJSON) {
  const data = json?.data || [];
  const logoUrl = data.find(b => b.type === 'logo')?.data?.url ?? null;
  const header  = data.find(b => b.type === 'header')?.data ?? {};
  const items   = data.find(b => b.type === 'item')?.data?.itemdata ?? [];
  const bigRows = data.find(b => b.type === 'bigsummary')?.data?.bigsummary ?? [];
  const sumRows = data.find(b => b.type === 'summary')?.data?.summary ?? [];
  const footers = data.filter(b => b.type === 'footer').map(b => b.data) ?? [];
  const thank   = json?.thankYou || (data.find(b => b.type === 'setting')?.data?.thankyou_note as string) || '';
  return { logoUrl, header, items, bigRows, sumRows, footers, thank };
}

function getCharWidth(json: ReceiptJSON) {
  const setting = json?.data?.find(b => b.type === 'setting')?.data ?? {};
  const w = toInt(json?.item_length ?? setting.item_length, 35); // 58mm ~32–38; 80mm ~48–56
  return clamp(w, 24, 64);
}

// ---------- MAIN (BATCHED) ----------
export async function renderReceipt(
  receiptJson: ReceiptJSON,
  transport: PrinterTransport,
  opts: RenderOptions
) {
  const TAG = '[receipt]';
  const { widthDots, logoScale = 0.55 } = opts;
  const width = getCharWidth(receiptJson);
  const { logoUrl, header, items, bigRows, sumRows, footers, thank } = parse(receiptJson);

  console.log(`${TAG} render start`, {
    widthDots,
    logoScale,
    calcCharWidth: width,
    hasLogo: !!logoUrl,
    headerKeys: Object.keys(header || {}),
    itemsCount: items.length,
    bigRows: bigRows?.length || 0,
    sumRows: sumRows?.length || 0,
    footers: footers?.length || 0,
    hasThanks: !!thank,
  });

  await saneState(transport);

  // 1) Logo (single image call)
  if (logoUrl) {
    try {
      console.log(`${TAG} logo: fetching`, { logoUrl, printerWidthDots: widthDots, logoScale });
      const t0 = Date.now();
      const { base64, widthDots: imgW } = await fetchLogoBase64ForPrinter(logoUrl, widthDots, logoScale);
      console.log(`${TAG} logo: fetched`, { imgW, b64len: base64.length, ms: Date.now() - t0 });
      await transport.printImageBase64(base64, { imageWidth: imgW });
      console.log(`${TAG} logo: printed`);
      await transport.printText('\n', {} as any);
    } catch (e) {
      console.warn(`${TAG} logo: failed to fetch/print`, e);
    }
  } else {
    console.log(`${TAG} logo: none`);
  }

  // 2) Header (one centered call)
  {
    const lines: string[] = [];
    const title: string = header?.top_title ?? '';
    const subs: string[] = header?.sub_titles ?? [];
    if (title) lines.push(title);
    for (const s of subs) lines.push(s);
    if (lines.length) {
      console.log(`${TAG} header: printing`, { lines });
      await transport.printText(lines.join('\n') + '\n', { align: 'center', bold: !!title } as any);
    } else {
      console.log(`${TAG} header: empty`);
    }
    await transport.printText(hr(width) + '\n', {} as any);
  }

  // 3) Items (1–2 calls max)
  {
    const cols = computeCols(width);
    console.log(`${TAG} items: columns`, cols);

    const buf: string[] = [];

    const head =
      rpad('Item', cols.item) + ' ' +
      rpad('Qty', cols.qty) + ' ' +
      rpad('Price', cols.price) + ' ' +
      rpad('Amount', cols.amount);
    buf.push(head);

    // CHANGE: add a dashed rule directly under the column header
    buf.push(hr(width));

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = String(it.item_name ?? '');
      const qtyN = toInt(it.quantity, 1);
      const lineTotal = Number(it.item_amount ?? it.price ?? 0);
      const unitPrice = qtyN ? lineTotal / qtyN : lineTotal;

      const lines = wrap(name, cols.item);
      const first = lines.shift() || '';

      // CHANGE: right-align numeric fields (price/amount) with 2 decimals
      const priceStr  = rAlign(formatMoney(unitPrice), cols.price);
      const amountStr = rAlign(formatMoney(lineTotal), cols.amount);

      const row =
        rpad(first, cols.item) + ' ' +
        rpad(String(qtyN), cols.qty) + ' ' +
        priceStr + ' ' +
        amountStr;
      buf.push(row);

      for (const tail of lines) {
        buf.push(
          rpad(tail, cols.item) + ' ' +
          rpad('',   cols.qty)   + ' ' +
          rpad('',   cols.price) + ' ' +
          rpad('',   cols.amount)
        );
      }

      if (it.item_subLine) {
        for (const s of wrap(String(it.item_subLine), cols.item - 2)) {
          buf.push(
            rpad('  ' + s, cols.item) + ' ' +
            rpad('', cols.qty) + ' ' +
            rpad('', cols.price) + ' ' +
            rpad('', cols.amount)
          );
        }
      }
    }

    console.log(`${TAG} items: printing`, { lines: buf.length });
    await transport.printText(buf.join('\n') + '\n', { bold: true } as any);
    await transport.printText(hr(width) + '\n', {} as any);
  }

  // 4) Big summary (one call)
  {
    const lines: string[] = [];
    for (const r of bigRows) {
      // CHANGE: ensure values on the right stay visually aligned
      lines.push(twoCols(String(r.key ?? ''), String(r.value ?? ''), width));
    }
    if (lines.length) {
      console.log(`${TAG} bigSummary: printing`, { linesCount: lines.length });
      await transport.printText(lines.join('\n') + '\n', {} as any);
      await transport.printText(hr(width) + '\n', {} as any);
    } else {
      console.log(`${TAG} bigSummary: empty`);
    }
  }

  // 5) Summary (one call)
  {
    const lines: string[] = [];
    for (const r of sumRows) {
      // CHANGE: same alignment style for summary rows
      lines.push(twoCols(String(r.key ?? ''), String(r.value ?? ''), width));
    }
    if (lines.length) {
      console.log(`${TAG} summary: printing`, { linesCount: lines.length });
      await transport.printText(lines.join('\n') + '\n', {} as any);
      await transport.printText(hr(width) + '\n', {} as any);
    } else {
      console.log(`${TAG} summary: empty`);
    }
  }

  // 6) Footers (group by align to reduce calls)
  if (Array.isArray(footers) && footers.length) {
    const leftLines = footers.filter(f => (f?.align ?? 'left') === 'left')
                             .flatMap(f => f.footer_text || []);
    const centerLines = footers.filter(f => f?.align === 'center')
                               .flatMap(f => f.footer_text || []);
    const rightLines = footers.filter(f => f?.align === 'right')
                              .flatMap(f => f.footer_text || []);
    console.log(`${TAG} footers: printing`, {
      left: leftLines.length,
      center: centerLines.length,
      right: rightLines.length,
    });

    if (leftLines.length) await transport.printText(leftLines.join('\n') + '\n', { align: 'left' } as any);
    if (centerLines.length) await transport.printText(centerLines.join('\n') + '\n', { align: 'center' } as any);
    if (rightLines.length) await transport.printText(rightLines.join('\n') + '\n', { align: 'right' } as any);
  } else {
    console.log(`${TAG} footers: none`);
  }

  // 7) Thank-you (one line)
  if (thank) {
    console.log(`${TAG} thanks: printing`, { thank });
    await transport.printText(thank + '\n', { align: 'center' } as any);
  } else {
    console.log(`${TAG} thanks: empty`);
  }

  // 8) Feed a bit, then CUT — ONE simple call; best effort on all transports.
  console.log(`${TAG} feed: printing 2 blank lines before cut`);
  await transport.printText('\n\n', {} as any);

  /* -------------------- NEW: use fallback cutter ------------------- */
  await cutWithFallback(transport);
  /* ---------------- end NEW (replaces transport.cut?.()) ----------- */

  console.log(`${TAG} render done`);
}
