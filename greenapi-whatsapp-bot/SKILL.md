---
name: greenapi-whatsapp-bot
description: >
  חיבור נכון ל-GreenAPI לבוטי WhatsApp — כולל כל המלכודות שנלמדו מניסיון.
  הפעל skill זה בכל פעם שבונים בוט WhatsApp דרך GreenAPI, מגדירים מופע חדש,
  מאבחנים למה הבוט לא שולח הודעות, מגדירים webhook, או כותבים קוד sendMessage.
  חובה להשתמש בסקיל הזה גם אם המשתמש רק אומר "גרין API", "בוט ווצאפ", "GreenAPI",
  "מופע חדש", "הבוט לא מגיב" — כי הטעויות כאן עדינות ויקרות.
---

# GreenAPI WhatsApp Bot — חיבור נכון

## המלכודות הנפוצות ביותר (קרא לפני הכל)

### 1. URL של ה-API — ללא מקף!
```
נכון:  https://7105.api.greenapi.com
שגוי:  https://7105.api.green-api.com
```
- ה-URL **המדויק** מופיע בדשבורד GreenAPI בשדה **apiUrl** של המופע
- תמיד העתק משם — אל תנחש
- כל מופע יושב על שרת לפי 4 הספרות הראשונות של ה-ID: מופע `7105629513` → `7105.api.greenapi.com`

### 2. messageId — אסור לשלוח במופעים חדשים (BUSINESS_USD ומעלה)
```typescript
// נכון
body: JSON.stringify({ chatId: `${phone}@c.us`, message })

// שגוי — גורם ל-400: 'messageId' is not allowed
body: JSON.stringify({ chatId: `${phone}@c.us`, message, messageId: '...' })
```

### 3. שדה senderPhone — השתנה בין גרסאות
מופעים ישנים: `senderData.senderPhone` = `"972XXXXXXXXX"` (ללא @c.us).
מופעים חדשים: רק `senderData.chatId` = `"972XXXXXXXXX@c.us"`, אין senderPhone.

תמיד תמוך בשני הפורמטים:
```typescript
const senderPhone =
  payload.senderData?.senderPhone ||
  payload.senderData?.chatId?.replace('@c.us', '').replace('@g.us', '') ||
  payload.senderData?.sender?.replace('@c.us', '').replace('@g.us', '');
```

---

## פתיחת מופע GreenAPI חדש — שלב אחר שלב

1. **פתח מופע** בדשבורד GreenAPI — העתק שלושה ערכים:
   - `apiUrl` (לדוגמה: `https://7105.api.greenapi.com`) — **המדויק מהדשבורד**
   - `idInstance` (לדוגמה: `7105629513`)
   - `apiTokenInstance`

2. **הגדר Webhook** בממשק GreenAPI:
   - Webhook URL: כתובת הפונקציה (למשל Supabase Edge Function)
   - `incomingWebhook`: **yes**
   - כל שאר ה-webhooks: **no**

3. **עדכן secrets** בסביבת הריצה:
   ```
   GREENAPI_API_URL=https://7105.api.greenapi.com
   GREENAPI_ID_INSTANCE=7105629513
   GREENAPI_API_TOKEN_INSTANCE=<token>
   ```

4. **חבר ל-WhatsApp** — סרוק QR code בדשבורד GreenAPI

5. **Reboot אחד** להפעלת webhook delivery:
   ```
   POST /setSettings → { webhookUrl, incomingWebhook: 'yes', שאר: 'no' }
   GET  /reboot
   ```

6. **בדוק sendMessage** לפני שתסמוך על הבוט:
   ```
   POST https://7105.api.greenapi.com/waInstance7105629513/sendMessage/<token>
   { "chatId": "972XXXXXXXXX@c.us", "message": "בדיקה" }
   ```
   תשובה תקינה: `{ "idMessage": "3EB0..." }` עם status 200.

---

## קוד sendMessage נכון

```typescript
async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  const instanceId = Deno.env.get('GREENAPI_ID_INSTANCE');
  const token     = Deno.env.get('GREENAPI_API_TOKEN_INSTANCE');
  const apiUrl    = Deno.env.get('GREENAPI_API_URL') || 'https://api.green-api.com';
  if (!instanceId || !token) return;

  try {
    const resp = await fetch(`${apiUrl}/waInstance${instanceId}/sendMessage/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: `${phone}@c.us`, message }),  // ללא messageId!
    });
    if (!resp.ok) console.error('GreenAPI send error:', await resp.text());
  } catch (err) {
    console.error('sendWhatsAppMessage error:', err);
  }
}
```

---

## קוד webhook handler נכון

```typescript
// חלץ senderPhone בצורה עמידה לשני הפורמטים
const senderPhone =
  payload.senderData?.senderPhone ||
  payload.senderData?.chatId?.replace('@c.us', '').replace('@g.us', '') ||
  payload.senderData?.sender?.replace('@c.us', '').replace('@g.us', '');

// דלג על הודעות מקבוצות
if (payload.senderData?.chatId?.includes('@g.us')) return new Response('ok');

// עבד רק הודעות נכנסות טקסטואליות
if (payload.typeWebhook !== 'incomingMessageReceived') return new Response('ok');
if (payload.messageData?.typeMessage !== 'textMessage') return new Response('ok');

const messageText = payload.messageData?.textMessageData?.textMessage?.trim();
if (!senderPhone || !messageText) return new Response('ok');
```

---

## דפוס fix-webhook — פונקציית תחזוקה מומלצת

כדאי לשמור פונקציית עזר נפרדת עם פעולות תחזוקה:

| action | מה עושה |
|--------|---------|
| (ללא) | מחזיר state + webhookUrl + registered phones |
| `test-send&phone=972XX` | שליחת הודעת בדיקה לטלפון ספציפי |
| `reboot` | setSettings + reboot |
| `broadcast&msg=TEXT` | שליחה לכל המשתמשים הרשומים |
| `setup-cron` | הגדרת keepwarm ב-pg_cron |
| `qr` | קבלת QR code חדש |
| `logout` | ניתוק מ-WhatsApp |
| `peek-queue` | הצצה לqueue ללא מחיקה |

---

## אבחון — הבוט מקבל webhooks אבל לא מגיב

1. **בדוק test-send** — האם sendMessage עובד?
   - 200 + `idMessage` → שליחה עובדת, הבעיה בלוגיקה
   - 400 `messageId is not allowed` → הסר messageId
   - 400/500 אחר → בדוק GREENAPI_API_URL (ללא מקף?)

2. **הוסף GET debug endpoint לפונקציה:**
   ```typescript
   if (req.method === 'GET') {
     return Response.json({
       instanceId: Deno.env.get('GREENAPI_ID_INSTANCE'),
       apiUrl: Deno.env.get('GREENAPI_API_URL'),
       hasToken: !!Deno.env.get('GREENAPI_API_TOKEN_INSTANCE'),
     });
   }
   ```

3. **webhook queue בדשבורד GreenAPI:**
   - queue = 0 → webhooks נמסרו, הבעיה בפונקציה (sendMessage נכשל בשקט)
   - queue > 0 → הפונקציה מחזירה 500

4. **לאחר עדכון secrets** — פרוס מחדש את הפונקציה לאלץ instance חדש

---

## אזהרות WhatsApp automation detection

- לעולם אל תשלח הרבה הודעות בפרק זמן קצר (40 ב-24 שעות = סיכון, 7 בשנייה = חסימה)
- לאחר חיבור מופע חדש — המתן בסבלנות לפני בדיקות מאסיביות
- Broadcast ל-7 משתמשים שונים = בסדר גמור
- בדיקות חוזרות מהקוד = מסוכן — השתמש ב-fix-webhook?action=test-send
