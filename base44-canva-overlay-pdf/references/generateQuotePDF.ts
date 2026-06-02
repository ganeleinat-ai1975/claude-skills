// Generate the full quote+contract PDF for Michal Wolberger Interior Design.
// Approach: 27 Canva pages as background JPEGs + a transparent text overlay on
// the dynamic pages only — cover (index 0), comparison table (index 14),
// prices (index 15), contract (index 23). Design reproduced pixel-perfect from
// Canva; only the client's data is overlaid.
//
// RTL: jsPDF reverses pure-LTR strings under setR2L(true) and reverses pure-Hebrew
// strings under setR2L(false). The fix is to toggle R2L PER STRING based on whether
// it contains a Hebrew char (see put()). Brackets are mirrored for RTL (fixRtl).
//
// Called from frontend / autoQuoteSent:
//   base44.functions.invoke('generateQuotePDF', { client_id, quote_id, title, package_type, total_amount, scope, meeting_date })
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { jsPDF } from 'npm:jspdf@4.0.0';

// Upload the 27 JPEGs (p-01.jpg … p-27.jpg) to Base44 and paste their public URLs
// here IN ORDER. Index 0 = cover (p-01), index 23 = contract (p-24).
const B = 'https://media.base44.com/images/public/69e4e3a98f5f3e4e5bd49dba/';
const PAGE_IMAGES: string[] = [
  B + 'c68651c3f_p-01.jpg', // 0  cover (dynamic)
  B + 'c04dac11b_p-02.jpg', // 1
  B + 'd9baae647_p-03.jpg', // 2
  B + 'c0287a4d6_p-04.jpg', // 3
  B + '883a904ed_p-05.jpg', // 4
  B + 'c79f5ebb1_p-06.jpg', // 5
  B + '218b9de44_p-07.jpg', // 6
  B + '125b5cf35_p-08.jpg', // 7
  B + 'a64363a35_p-09.jpg', // 8
  B + 'a3ce1e1fb_p-10.jpg', // 9
  B + '4daa96b52_p-11.jpg', // 10
  B + '7c2d46126_p-12.jpg', // 11
  B + 'b9fa781dd_p-13.jpg', // 12
  B + 'ef1f00041_p-14.jpg', // 13  comparison table part 1 (text baked into JPEG)
  B + 'adbbb37d5_p-15.jpg', // 14  comparison table part 2 (dynamic S/M/L overlay)
  B + 'bdd63fda7_p-16.jpg', // 15  investment / prices (dynamic)
  B + 'dfb07220c_p-17.jpg', // 16
  B + 'ed071e133_p-18.jpg', // 17
  B + '8ffe8d213_p-19.jpg', // 18
  B + '3af05f0d4_p-20.jpg', // 19
  B + '33be831d0_p-21.jpg', // 20
  B + '1cecaa474_p-22.jpg', // 21
  B + '053152709_p-23.jpg', // 22
  B + 'bcccd9ce8_p-24.jpg', // 23  contract (dynamic)
  B + '463816653_p-25.jpg', // 24
  B + '9b33cace9_p-26.jpg', // 25
  B + '4853b4a4e_p-27.jpg', // 26
];

const COVER_INDEX = 0;     // p-01.jpg
const P15_INDEX = 14;      // p-15.jpg — package comparison table (S/M/L cells)
const P16_INDEX = 15;      // p-16.jpg — investment page (3 package prices)
const CONTRACT_INDEX = 23; // p-24.jpg

// p-15 comparison rows — keys must match the form on the quote screen.
// Columns measured directly from p-15.jpg cell centroids (NOT shared with p-16 —
// p-15's grid is ~8mm narrower and shifted left). Cell centers: S=24, M=72, L=119mm.
const CMP_COL_X = { s: 24, m: 72, l: 119 };
const CMP_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['renders', 69],
  ['materials', 90],
  ['bathrooms', 114],
  ['project_mgmt', 144],
  ['cloud', 167],
  ['budget', 190],
  ['install_days', 207],
  ['styling', 224],
  ['shopping', 261],
];

const HEB = /[֐-׿]/;

// Full Heebo TTF (variable font) — the subset CSS approach returns no .ttf, so fetch the full file.
const HEEBO_TTF_URL = 'https://github.com/google/fonts/raw/main/ofl/heebo/Heebo%5Bwght%5D.ttf';

async function fetchBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed ${resp.status} ${url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let binary = '';
  const chunk = 0x8000; // chunked — String.fromCharCode(...wholeBuf) overflows the stack
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // signDate: only sent at the contract-signing stage; absent during the quote stage.
    const { client_id, quote_id, total_amount, meeting_date, signDate } = await req.json();

    const clients = await base44.asServiceRole.entities.Client.filter({ id: client_id });
    if (clients.length === 0) return Response.json({ error: 'Client not found' }, { status: 404 });
    const client = clients[0];

    let quote: any = null;
    if (quote_id) {
      const quotes = await base44.asServiceRole.entities.Quote.filter({ id: quote_id });
      quote = quotes[0] || null;
    }

    if (PAGE_IMAGES.length !== 27) {
      return Response.json({ error: `PAGE_IMAGES must have exactly 27 URLs in order (p-01..p-27). Got ${PAGE_IMAGES.length}.` }, { status: 500 });
    }

    const heeboBase64 = await fetchBase64(HEEBO_TTF_URL).catch((e) => { console.error('Heebo fetch failed:', e); return ''; });

    // Load all page images SEQUENTIALLY with per-image logging. Parallel fetch of 27
    // files can trip rate limits / drop the first burst → blank pages.
    const pageImages: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < PAGE_IMAGES.length; i++) {
      try {
        const b64 = await fetchBase64(PAGE_IMAGES[i]);
        if (!b64 || b64.length < 100) throw new Error(`empty/too small (${b64.length} chars)`);
        console.log(`img ${i + 1}/27 ok — ${b64.length} chars`);
        pageImages.push(b64);
      } catch (e) {
        console.error(`img ${i + 1}/27 FAILED — ${PAGE_IMAGES[i]} — ${e.message}`);
        failed.push(`#${i + 1}: ${PAGE_IMAGES[i]} (${e.message})`);
        pageImages.push('');
      }
    }
    if (failed.length) {
      return Response.json({ error: `Image load failed for ${failed.length}/27:\n${failed.join('\n')}` }, { status: 500 });
    }

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    if (heeboBase64) {
      doc.addFileToVFS('Heebo.ttf', heeboBase64);
      doc.addFont('Heebo.ttf', 'Heebo', 'normal');
      doc.setFont('Heebo');
    }
    const W = 210, H = 297;

    // RTL bracket mirroring: jsPDF does NOT mirror paired punctuation under R2L,
    // so "(...)" inside Hebrew text renders reversed. Swap each pair (Hebrew only).
    const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
    const fixRtl = (s: string) => s.replace(/[()\[\]{}<>]/g, (c) => MIRROR[c] ?? c);

    // Per-string RTL: Hebrew → R2L on, pure-LTR (numbers/email/phone) → R2L off.
    const put = (txt: unknown, x: number, y: number, align: 'left' | 'center' | 'right', size: number) => {
      const t = String(txt ?? '');
      if (!t) return;
      doc.setFontSize(size);
      const rtl = HEB.test(t);
      doc.setR2L(rtl);
      doc.text(rtl ? fixRtl(t) : t, x, y, { align });
      doc.setR2L(false);
    };

    const today = new Date();
    const coverDate = today.toLocaleDateString('he-IL');
    const quoteDate = meeting_date ? new Date(meeting_date).toLocaleDateString('he-IL') : coverDate;
    const amountStr = total_amount != null ? Number(total_amount).toLocaleString('he-IL') : '';
    const city = client.city || '';
    const coverLine = city ? `${client.name || ''}, ${city}` : (client.name || '');
    const addressLine = [client.address, city].filter(Boolean).join(', ');
    const money = (v: unknown) => (v != null && v !== '' ? Number(v).toLocaleString('he-IL') : '');
    const priceS = money(quote?.price_small);
    const priceM = money(quote?.price_medium);
    const priceL = money(quote?.price_large);
    // comparison: JSON of { rowKey: { s, m, l } }; each cell a free string (✓ / text / number).
    let comparison: Record<string, { s?: unknown; m?: unknown; l?: unknown }> = {};
    if (quote?.comparison) {
      comparison = typeof quote.comparison === 'string'
        ? (() => { try { return JSON.parse(quote.comparison); } catch { return {}; } })()
        : quote.comparison;
    }

    for (let i = 0; i < pageImages.length; i++) {
      if (i > 0) doc.addPage();
      doc.addImage(pageImages[i], 'JPEG', 0, 0, W, H);

      if (i === COVER_INDEX) {
        doc.setTextColor(74, 53, 38);
        put(coverLine, W / 2, 260, 'center', 12);
        put(coverDate, W / 2, 266, 'center', 11);
      }

      if (i === P15_INDEX) {
        doc.setTextColor(40, 40, 40);
        const isCheck = (v: unknown) => {
          const s = String(v ?? '').trim().toLowerCase();
          return s === '✓' || s === '✔' || s === 'v' || s === 'true' || s === 'כן';
        };
        const drawCheck = (cx: number, cy: number) => {
          doc.setDrawColor(40, 40, 40);
          doc.setLineWidth(0.6);
          doc.line(cx - 2, cy - 0.2, cx - 0.6, cy + 1.5);
          doc.line(cx - 0.6, cy + 1.5, cx + 2.4, cy - 2.4);
        };
        for (const [key, y] of CMP_ROWS) {
          const cell = comparison[key] || {};
          for (const col of ['s', 'm', 'l'] as const) {
            const val = cell[col];
            if (val == null || String(val).trim() === '') continue;
            const x = CMP_COL_X[col];
            if (isCheck(val)) {
              drawCheck(x, y - 1);
            } else {
              doc.setFontSize(9);
              const rtl = HEB.test(String(val));
              doc.setR2L(rtl);
              const lines = doc.splitTextToSize(rtl ? fixRtl(String(val)) : String(val), 40);
              const lh = 3.8;
              let yy = y - ((lines.length - 1) * lh) / 2;
              for (const ln of lines) { doc.text(ln, x, yy, { align: 'center' }); yy += lh; }
              doc.setR2L(false);
            }
          }
        }
      }

      if (i === P16_INDEX) {
        doc.setTextColor(58, 42, 30);
        put(priceS, 31, 80, 'center', 16);
        put(priceM, 82, 80, 'center', 16);
        put(priceL, 130, 80, 'center', 16);
      }

      if (i === CONTRACT_INDEX) {
        doc.setTextColor(58, 42, 30);
        // client identity — baseline nudged ABOVE each dashed line so the dash
        // never runs through the glyphs.
        put(client.name, 130, 104, 'right', 13);
        put(client.id_number, 138, 112, 'right', 13);
        put(client.phone, 139, 120, 'right', 12);
        put(addressLine, 138, 132, 'right', 12);
        put(client.email, 140, 140, 'right', 12);
        put(amountStr, 62, 206, 'center', 12);
        put(quoteDate, 35, 224, 'center', 11);

        // Signing date — only stamped once the contract is actually signed.
        // RTL: day rightmost (largest x), year leftmost (smallest x).
        if (signDate) {
          const d = new Date(signDate);
          put(String(d.getDate()), 120, 50, 'center', 11);
          put(String(d.getMonth() + 1), 92, 50, 'center', 11);
          put(String(d.getFullYear()), 68, 50, 'center', 11);
        }
      }
    }

    const pdfBytes = doc.output('arraybuffer');
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const file = new File([blob], `quote_${client.name}_${Date.now()}.pdf`, { type: 'application/pdf' });
    const { file_url } = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ success: true, file_url });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
