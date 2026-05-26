---
name: base44-digital-signature
description: >
  מערכת חתימה דיגיטלית מלאה ב-Base44 — שליחת מסמך לחתימה ללקוח דרך קישור ייחודי,
  החתימה מוטמעת ב-PDF המקורי, והמסמך החתום נשמר במערכת.
  השתמש בסקיל זה כשרוצים לממש חתימה דיגיטלית על PDF ב-Base44,
  כשיש בעיה עם הטמעת חתימה ב-Deno (fetch data:URL, pdf-lib, Hebrew text),
  כשדף החתימה הוא ציבורי (ללא login) ו-UploadFile נכשל,
  או כשרוצים להבין את הארכיטקטורה הנכונה לפתרון כזה ב-Base44.
---

# Base44 — Digital Signature on PDF

## ⚠️ קריטי — שתי גישות לפי סוג דף החתימה

| מצב | גישה לחתימה |
|-----|-------------|
| דף חתימה **מחובר** (דורש login) | Frontend מעלה PNG → שולח HTTPS URL לbackend |
| דף חתימה **ציבורי** (ללא login) | Frontend שולח base64 → Backend מפענח עם `atob()` |

**למה זה חשוב:** `base44.integrations.Core.UploadFile` דורש session מחובר. בדף ציבורי — אין session, ה-upload נכשל עם שגיאה.

---

## ארכיטקטורה — גישה א׳ (דף מחובר)

```
Admin → יוצר Document עם signature_token
      → שולח קישור /sign?token=XXX ללקוח (WhatsApp / Email)

Client → נכנס לדף /sign?token=XXX (מחובר)
       → חותם על canvas
       → מעלה חתימה כ-PNG לBase44 storage (HTTPS URL)
       → קורא ל-submitSignature עם HTTPS URL

submitSignature (Deno) → טוען PDF מקורי מ-doc.file_url
                       → מוריד תמונת חתימה מ-HTTPS URL (fetch עובד)
                       → pdf-lib מטמיע חתימה בעמוד האחרון
                       → מעלה PDF חתום → שומר signed_pdf_url
                       → מעדכן signature_status: 'signed'
```

## ארכיטקטורה — גישה ב׳ (דף ציבורי)

```
Admin → יוצר Document עם signature_token
      → שולח קישור /sign?token=XXX ללקוח

Client → נכנס לדף /sign?token=XXX (ציבורי, ללא login)
       → חותם על canvas
       → שולח base64 data URL ישירות ל-submitSignature (ללא upload)

submitSignature (Deno) → טוען PDF מקורי מ-doc.file_url
                       → מפענח base64 ל-Uint8Array עם atob()
                       → pdf-lib מטמיע חתימה
                       → מעלה PDF חתום (service role — עובד)
                       → מעדכן signature_status: 'signed'
```

---

## קבצים

| קובץ | תפקיד |
|------|--------|
| `base44/functions/getSignatureData/entry.ts` | מחזיר מידע מסמך לפי token (ציבורי) |
| `base44/functions/submitSignature/entry.ts` | מקבל חתימה, מטמיע ב-PDF, מעדכן entity |
| `src/pages/SignDocument.jsx` | דף ציבורי `/sign?token=XXX` |
| `src/components/documents/DocumentSignatureBadge.jsx` | badge בממשק עם כפתורי שליחה |

ראה קוד מלא: `references/final-code.md`

---

## Document Entity — שדות חתימה

```json
{
  "signature_token": "string — UUID ייחודי לקישור",
  "signature_status": "draft | pending_signature | signed",
  "signed_at": "datetime",
  "signer_name": "string",
  "signature_image_url": "string — URL לתמונת החתימה (גישה א׳)",
  "signature_data": "string — base64 data URL (גישה ב׳)",
  "signed_pdf_url": "string — URL ל-PDF החתום",
  "file_url": "string — URL ל-PDF (מתעדכן לחתום)"
}
```

---

## תקלות ופתרונות

### 1. `fetch(data:URL)` לא עובד ב-Deno
**בעיה:** הקוד המקורי שלח `canvas.toDataURL()` (data:URL) לשרת, ואז ניסה `fetch(data:URL)` ב-Deno — זה לא נתמך.

**פתרון א׳ — דף מחובר:** ב-`SignDocument.jsx` להעלות קודם כ-PNG file ולשלוח HTTPS URL:
```javascript
const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
const file = new File([blob], 'signature.png', { type: 'image/png' });
const { file_url } = await base44.integrations.Core.UploadFile({ file });
// שלח file_url (HTTPS) ל-submitSignature
```

**פתרון ב׳ — דף ציבורי:** שלח base64, פענח בbackend:
```javascript
// Frontend — פשוט שלח base64
const signatureData = canvasRef.current.toDataURL('image/png');
await base44.functions.invoke('submitSignature', { signature_data: signatureData, ... });
```
```typescript
// Backend — פענח עם atob()
const base64Data = signature_data.includes(',') ? signature_data.split(',')[1] : signature_data;
const binary = atob(base64Data);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
const sigImage = await pdfDoc.embedPng(bytes); // bytes ישירות — לא bytes.buffer
```

### 2. `UploadFile` נכשל בדף ציבורי
**בעיה:** `base44.integrations.Core.UploadFile` דורש session. בדף חתימה ציבורי (ללא login) הקריאה נכשלת.

**תסמין:** שגיאה גנרית "שגיאה בשמירת החתימה" — ה-error נזרק לפני שליחה לbackend.

**פתרון:** השתמש בגישה ב׳ — שלח base64 ישירות לbackend. הbackend עובד עם service role ויכול להעלות קבצים.

### 3. `bytes.buffer` לא `bytes` ב-embedPng
**בעיה:** `pdfDoc.embedPng(bytes.buffer)` — בחלק מהמקרים גורם לשגיאה או לתמונה לא תקינה.

**פתרון:**
```typescript
// ❌ ישן
const sigImage = await pdfDoc.embedPng(bytes.buffer);

// ✅ נכון
const sigImage = await pdfDoc.embedPng(bytes);
```

### 4. טקסט עברי קורס את pdf-lib
**בעיה:** `StandardFonts.Helvetica` לא תומך בעברית. גורם ל-500 error.

**פתרון:** להשתמש רק באנגלית ובמספרים על ה-PDF:
```typescript
lastPage.drawText('Digital Signature', { ... }); // ✅
lastPage.drawText('Signed: ' + new Date().toLocaleDateString('en-GB'), { ... }); // ✅
// ❌ אל תכניס signer_name אם הוא עברית
```
השם נשמר ב-entity ומוצג בממשק הניהול.

### 5. content-type check חוסם embedding
**בעיה:** הקוד בדק `if (contentType.includes('pdf') || url.includes('.pdf'))` — Base44 CDN URLs לא תמיד מחזירים content-type נכון.

**פתרון:** בדוק רק אם ה-fetch הצליח:
```typescript
const pdfRes = await fetch(doc.file_url);
if (!pdfRes.ok) throw new Error(`PDF fetch failed: ${pdfRes.status}`);
// המשך לטעינה — PDFDocument.load() יזרוק אם לא תקין
```

### 6. Gmail OAuth פג תוקף
**בעיה:** Google OAuth tokens ב-Base44 testing mode פגים כל 7 ימים.

**פתרון:** לעבור ל-Brevo (API key סטטי, לא פג):
```typescript
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY');
await fetch('https://api.brevo.com/v3/smtp/email', {
  method: 'POST',
  headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sender: { name: 'שם הסטודיו', email: 'sender@gmail.com' },
    to: [{ email: recipient }],
    subject: '...',
    htmlContent: '...',
  })
});
```

### 7. pdf-lib נכשל בשקט
**בעיה:** הקוד עטוף ב-`try/catch` שבולע שגיאות. ה-PDF לא נוצר, הקוד ממשיך.

**פתרון:** הוסף `console.error` מפורט. בזמן debugging — הוצא מה-try/catch.

---

## כללים קריטיים ל-Base44

- **דף ציבורי** — לא לקרוא ל-`UploadFile` מהדפדפן. שלח base64 לbackend.
- **דף מחובר** — אפשר `UploadFile` מהדפדפן, שלח HTTPS URL לbackend.
- `fetch(data:URL)` — לא עובד ב-Deno. תמיד HTTPS URL או base64+atob.
- `StandardFonts.Helvetica` — לא תומך בעברית. אנגלית בלבד על ה-PDF.
- `embedPng(bytes)` — לא `embedPng(bytes.buffer)`.
- `try/catch` שבולע שגיאות — מסוכן. הוסף logs.
- Email ב-Base44 production: Brevo, לא Gmail OAuth.
- בדוק `pdfRes.ok` לפני `arrayBuffer()`.

---

## סדר בנייה מומלץ לפרויקט חדש

1. הגדר שדות חתימה ב-entity
2. בנה `getSignatureData` — פונקציה ציבורית שמחזירה מידע + file_url
3. **החלט: דף מחובר או ציבורי?** ← קובע את גישת שליחת החתימה
4. בנה `SignDocument.jsx` בהתאם לגישה
5. בנה `submitSignature` — pdf-lib, אנגלית בלבד, embedPng(bytes)
6. הוסף `DocumentSignatureBadge` לממשק

ראה קוד מלא: `references/final-code.md`
