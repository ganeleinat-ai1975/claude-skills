---
name: base44-digital-signature
description: >
  מערכת חתימה דיגיטלית מלאה ב-Base44 — שליחת מסמך לחתימה ללקוח דרך קישור ייחודי,
  החתימה מוטמעת ב-PDF המקורי, והמסמך החתום נשמר במערכת.
  השתמש בסקיל זה כשרוצים לממש חתימה דיגיטלית על PDF ב-Base44,
  כשיש בעיה עם הטמעת חתימה ב-Deno (fetch data:URL, pdf-lib, Hebrew text),
  או כשרוצים להבין את הארכיטקטורה הנכונה לפתרון כזה ב-Base44.
---

# Base44 — Digital Signature on PDF

## ארכיטקטורה

```
Admin → יוצר Document עם signature_token
      → שולח קישור /sign?token=XXX ללקוח (WhatsApp / Email)

Client → נכנס לדף /sign?token=XXX (דף ציבורי, ללא auth)
       → חותם על canvas
       → הקוד מעלה חתימה כ-PNG לBase44 storage (HTTPS URL)
       → קורא ל-submitSignature עם HTTPS URL

submitSignature (Deno) → טוען PDF מקורי מ-doc.file_url
                       → מוריד תמונת חתימה מ-HTTPS URL
                       → pdf-lib מטמיע חתימה בעמוד האחרון
                       → מעלה PDF חתום → שומר ב-signed_pdf_url
                       → מעדכן signature_status: 'signed'
                       → שולח מייל לאדמין דרך Brevo
```

## קבצים

| קובץ | תפקיד |
|------|--------|
| `base44/functions/getSignatureData/entry.ts` | מחזיר מידע מסמך לפי token (ציבורי) |
| `base44/functions/submitSignature/entry.ts` | מקבל חתימה, מטמיע ב-PDF, מעדכן entity |
| `src/pages/SignDocument.jsx` | דף ציבורי `/sign?token=XXX` |
| `src/components/documents/DocumentSignatureBadge.jsx` | badge בממשק עם כפתורי שליחה |

ראה קוד מלא: `references/final-code.md`

## Document Entity — שדות חתימה

```json
{
  "signature_token": "string — UUID ייחודי לקישור",
  "signature_status": "draft | pending_signature | signed",
  "signed_at": "datetime",
  "signer_name": "string",
  "signature_image_url": "string — URL לתמונת החתימה",
  "signed_pdf_url": "string — URL ל-PDF החתום"
}
```

## תקלות ופתרונות

### 1. `fetch(data:URL)` לא עובד ב-Deno
**בעיה:** הקוד המקורי שלח `canvas.toDataURL()` (data:URL) לשרת, ואז ניסה `fetch(data:URL)` ב-Deno — זה לא נתמך.

**פתרון:** ב-`SignDocument.jsx` — להעלות את החתימה קודם כ-PNG file, ולשלוח HTTPS URL:
```javascript
const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
const file = new File([blob], 'signature.png', { type: 'image/png' });
const { file_url } = await base44.integrations.Core.UploadFile({ file });
// שלח file_url (HTTPS) ל-submitSignature, לא את data:URL
```

### 2. טקסט עברית קורס את pdf-lib
**בעיה:** `lastPage.drawText(signer_name, { font: StandardFonts.Helvetica })` — Helvetica לא תומך בעברית. גורם ל-500 error.

**פתרון:** לא לכתוב טקסט עברי על ה-PDF. להשתמש רק באנגלית ובמספרים:
```typescript
lastPage.drawText('Digital Signature', { ... }); // אנגלית — עובד
lastPage.drawText('Signed: ' + new Date().toLocaleDateString('en-GB'), { ... }); // תאריך — עובד
// אל תכניס signer_name אם הוא עברית
```
השם נשמר בשדה `signer_name` ב-entity — אפשר לראות אותו בממשק.

### 3. pdf-lib נכשל בשקט
**בעיה:** הקוד היה עטוף ב-`try/catch` שבולע שגיאות. ה-PDF לא נוצר, אבל הקוד ממשיך בלי שגיאה.

**פתרון:** להוסיף `console.error` מפורט ולהסיר את ה-`try/catch` מסביב לשלבים הקריטיים בזמן debugging. אחרי שמוכח שעובד — אפשר להחזיר.

### 4. Gmail OAuth פג תוקף
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
הוסף `BREVO_API_KEY` ב-Base44 Environment Variables.

### 5. html2canvas לא מצלם `<img>` בזמן
**בעיה:** ניסיון ליצור certificate PDF בדפדפן עם html2canvas — התמונה לא נטענה לפני הצילום, יצא ריבוע ריק.

**פתרון שנבדק:** המתן ל-onload לפני html2canvas.
**פתרון סופי:** לא לבנות certificate נפרד — להטמיע ישירות ב-PDF המקורי עם pdf-lib בשרת.

### 6. אחרי revert — שינויים אחרים נפגעו
**לקח:** לפני כל שינוי בקובץ — לגבות. לאחר revert — לבדוק שמנגנונים אחרים (מיילים וכו') עדיין עובדים.

## כללים קריטיים ל-Base44

- `fetch(data:URL)` — לא עובד ב-Deno. תמיד העלה קובץ קודם, שלח HTTPS URL.
- `StandardFonts.Helvetica` — לא תומך בעברית. השתמש באנגלית בלבד.
- `try/catch` שבולע שגיאות — מסוכן. הוסף logs.
- שינוי קובץ אחד יכול לשבור קוד אחר — תמיד בדוק אחרי שינוי.
- Email ב-Base44 production: השתמש ב-Brevo, לא ב-Gmail OAuth.

## סדר בנייה מומלץ לפרויקט חדש

1. הגדר שדות חתימה ב-entity (signature_token, signature_status, signed_at, signer_name, signature_image_url, signed_pdf_url)
2. בנה `getSignatureData` — פונקציה ציבורית שמחזירה מידע מסמך לפי token
3. בנה `SignDocument.jsx` — דף ציבורי עם canvas, **העלה חתימה כ-PNG לפני שליחה לשרת**
4. בנה `submitSignature` — pdf-lib, fetch HTTPS URL, טקסט באנגלית בלבד
5. הוסף `DocumentSignatureBadge` לממשק עם כפתורי "שלח לחתימה" / "העתק קישור"

---

ראה קוד מלא: `references/final-code.md`
