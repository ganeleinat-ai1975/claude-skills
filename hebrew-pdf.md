# סקיל: ייצור PDF בעברית (RTL) ממערכות שונות

## מתי להשתמש בסקיל הזה
כשצריך לייצר PDF בעברית מ:
- אפליקציית **React** (כולל Base44 frontend)
- אפליקציית **Base44** (Deno functions / server-side)
- כל מערכת **Node.js / Deno**
- כל **web app** שצריך הצעות מחיר, חשבוניות, דוחות בעברית

---

## הכלל הבסיסי 🔑

> **אל תנסה לכתוב עברית ישירות ב-jsPDF**  
> jsPDF לא תומך ב-RTL ו-glyph shaping עברי. האותיות מתהפכות, מתפצלות, ומגיעות מימין שמאל.

**הפתרון הנכון:**  
גרום לדפדפן לצייר את העברית → לכידת תמונה → שמירה כ-PDF.

---

## שיטה 1: React / Base44 Frontend (הכי פשוט ✅)

### התקנה
```bash
npm install jspdf html2canvas
```

### הקוד
```jsx
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { useRef } from 'react'

export default function QuoteWithPDF() {
  const contentRef = useRef(null)

  const downloadPDF = async () => {
    const el = contentRef.current
    
    // שלב 1: html2canvas מצלם את ה-HTML המרונדר (כולל עברית RTL מושלמת)
    const canvas = await html2canvas(el, {
      scale: 2,              // רזולוציה כפולה = איכות גבוהה
      useCORS: true,
      backgroundColor: '#ffffff',
      scrollY: 0,
      windowWidth: el.scrollWidth,
      windowHeight: el.scrollHeight,
    })

    // שלב 2: המרה ל-PDF A4
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageW = pdf.internal.pageSize.getWidth()   // 210mm
    const pageH = pdf.internal.pageSize.getHeight()  // 297mm
    const margin = 10
    const usableW = pageW - margin * 2
    const imgH = (canvas.height * usableW) / canvas.width

    // שלב 3: חלוקה לעמודים אם התוכן ארוך
    let remaining = imgH
    let pageIndex = 0

    while (remaining > 0) {
      const sliceH = Math.min(remaining, pageH - margin * 2)
      const srcY = (imgH - remaining) * (canvas.height / imgH)
      const srcH = sliceH * (canvas.height / imgH)

      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = srcH
      slice.getContext('2d').drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH)

      if (pageIndex > 0) pdf.addPage()
      pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin, margin, usableW, sliceH)

      remaining -= sliceH
      pageIndex++
    }

    pdf.save('document.pdf')
  }

  return (
    <div>
      {/* התוכן שיהפוך ל-PDF — חשוב: dir="rtl" */}
      <div ref={contentRef} dir="rtl" style={{ background: 'white', padding: '24px', fontFamily: 'Arial, sans-serif' }}>
        <h1>הצעת מחיר</h1>
        <p>שלום יוסי, מצורפת הצעת המחיר שלנו...</p>
        {/* ... שאר התוכן */}
      </div>

      <button onClick={downloadPDF}>📄 הורד PDF</button>
    </div>
  )
}
```

### שימוש ב-Base44 (React frontend)
בדיוק אותו קוד — Base44 frontend הוא React, html2canvas עובד מצוין.  
הוסף את `jspdf` ו-`html2canvas` ב-`package.json` של הפרויקט.

---

## שיטה 2: Base44 Deno Function / Server-Side

כשצריך לייצר PDF **בלי דפדפן** (webhook, scheduled job, API endpoint).

### אפשרות A — Puppeteer API (מומלץ 🏆)

השתמש בשירות Headless Browser חיצוני כמו [Browserless.io](https://browserless.io) (יש Free tier).

```typescript
// Base44 Deno function
export default async function handler(req: Request) {
  const { clientName, items, total } = await req.json()

  // בנה HTML עם עברית + RTL
  const html = `
    <!DOCTYPE html>
    <html dir="rtl" lang="he">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; direction: rtl; padding: 32px; }
        h1 { color: #1e441e; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px 12px; border: 1px solid #ddd; text-align: right; }
        th { background: #eef6f2; }
        .total { font-size: 18px; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>הצעת מחיר</h1>
      <p>ללקוח: ${clientName}</p>
      <table>
        <thead><tr><th>פריט</th><th>מחיר</th></tr></thead>
        <tbody>
          ${items.map(i => `<tr><td>${i.name}</td><td>₪${i.price}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="total">סה"כ: ₪${total}</p>
    </body>
    </html>
  `

  // שלח ל-Puppeteer API לייצור PDF
  const response = await fetch('https://chrome.browserless.io/pdf?token=YOUR_TOKEN', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      options: { format: 'A4', printBackground: true }
    })
  })

  const pdfBuffer = await response.arrayBuffer()

  return new Response(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="quote-${clientName}.pdf"`
    }
  })
}
```

### אפשרות B — HTML-to-PDF API (PDFShift)

```typescript
const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${btoa('api:' + Deno.env.get('PDFSHIFT_KEY'))}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    source: html,          // HTML string עם עברית
    landscape: false,
    format: 'A4',
  })
})
const pdf = await response.arrayBuffer()
```

### אפשרות C — jsPDF עם פונט עברי (offline, בלי API)

```typescript
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1'

// טעינת פונט TTF עברי (Alef / Open Sans Hebrew)
const fontResponse = await fetch('https://fonts.gstatic.com/s/alef/v21/FeVQS0BTqb3A6OzG.ttf')
const fontBuffer = await fontResponse.arrayBuffer()
const fontBase64 = btoa(String.fromCharCode(...new Uint8Array(fontBuffer)))

const pdf = new jsPDF()
pdf.addFileToVFS('Alef-Regular.ttf', fontBase64)
pdf.addFont('Alef-Regular.ttf', 'Alef', 'normal')
pdf.setFont('Alef')
pdf.setR2L(true)  // הפעל RTL

pdf.setFontSize(16)
pdf.text('הצעת מחיר', 200, 20, { align: 'right' })
pdf.text(`ללקוח: ${clientName}`, 200, 35, { align: 'right' })
```

> **הערה:** אפשרות C פחות אמינה עם ניקוד, מעורבבת עברית/אנגלית, וצורות אותיות. מומלצת רק כ-fallback.

---

## דפוסים חשובים

### CSS הכרחי ל-RTL ב-HTML
```css
body {
  direction: rtl;
  font-family: Arial, 'Segoe UI', sans-serif; /* Arial תומך עברית בכל מערכת */
  unicode-bidi: embed;
}
```

### מניעת גלישת שורות שבורות
```css
* { box-sizing: border-box; }
table { table-layout: fixed; }
td, th { word-break: break-word; }
```

### ₪ ומספרים — כיוון נכון
```html
<!-- נכון: סכום LTR בתוך RTL -->
<span dir="ltr">₪1,234</span>

<!-- או ב-CSS -->
<span style="unicode-bidi: isolate; direction: ltr;">₪1,234</span>
```

---

## טבלת בחירה מהירה

| מצב | כלי מומלץ |
|-----|-----------|
| React app (לקוח) | html2canvas + jsPDF |
| Base44 frontend | html2canvas + jsPDF |
| Base44 Deno function | Browserless.io / PDFShift API |
| Node.js backend | Puppeteer headless |
| Offline, בלי API | jsPDF + Hebrew TTF font |

---

## קישורים
- [jsPDF](https://github.com/parallax/jsPDF)
- [html2canvas](https://html2canvas.hertzen.com/)
- [Browserless.io](https://browserless.io) — Headless Chromium as a service
- [PDFShift](https://pdfshift.io) — HTML to PDF API
- [Alef Font (עברית)](https://fonts.google.com/specimen/Alef)

