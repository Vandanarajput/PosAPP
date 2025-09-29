import RNBlobUtil from 'react-native-blob-util';
import ImageResizer from 'react-native-image-resizer';
import { appendLog } from './logger';

export async function fetchLogoBase64ForPrinter(
  url: string,
  printerWidthDots: number,
  scale: number = 0.55
): Promise<{ base64: string; widthDots: number }> {
  const TAG = '[logo]';

  // ——— start + input params
  console.log(`${TAG} start`, { url, printerWidthDots, scale });

  const t0 = Date.now();
  const resp = await RNBlobUtil
    .config({ fileCache: true })
    .fetch('GET', url);

  const local = resp.path();
  console.log(`${TAG} downloaded`, {
    url,
    httpStatus: resp.info?.().status,
    localPath: local,
    ms: Date.now() - t0,
  });

  try {
    const drawW = Math.floor(printerWidthDots * scale);
    console.log(`${TAG} resize target`, { drawW, printerWidthDots, scale });

    const t1 = Date.now();
    const jpg = await ImageResizer.createResizedImage(local, drawW, drawW, 'JPEG', 92);
    console.log(`${TAG} resized`, { outPath: jpg.path, ms: Date.now() - t1 });

    const t2 = Date.now();
    const base64 = await RNBlobUtil.fs.readFile(jpg.path, 'base64');
    console.log(`${TAG} base64 ready`, {
      b64len: base64.length,
      bytesApprox: Math.ceil((base64.length * 3) / 4),
      ms: Date.now() - t2,
    });

    return { base64, widthDots: drawW };
  } catch (e) {
    console.error(`${TAG} ERROR`, e);
    throw e;
  } finally {
    RNBlobUtil.fs.unlink(local).catch(() => {});
    console.log(`${TAG} cleanup done`);
  }
}
