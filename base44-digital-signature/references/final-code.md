# קוד סופי — מערכת חתימה דיגיטלית Base44

## 1. `base44/functions/submitSignature/entry.ts`

```typescript
// Public function — embeds signature into the original PDF using pdf-lib, then saves
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { PDFDocument, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const base44 = createClientFromRequest(req);
    const { token, signer_name, signature_image_url } = body;

    if (!token || !signer_name || !signature_image_url) {
      return Response.json({ error: 'missing_fields' }, { status: 400 });
    }

    // Find document by token
    let docs = await base44.asServiceRole.entities.Document.filter({ signature_token: token });
    if (!docs?.length) {
      const pending = await base44.asServiceRole.entities.Document.filter({ signature_status: 'pending_signature' });
      docs = pending.filter(d => d.signature_token === token);
    }
    if (!docs?.length) return Response.json({ error: 'not_found' }, { status: 404 });
    const doc = docs[0];
    if (doc.signature_status === 'signed') return Response.json({ error: 'already_signed' }, { status: 410 });

    const signedAt = new Date().toISOString();
    const signedAtDisplay = new Date().toLocaleString('he-IL');

    // --- Embed signature into the original PDF ---
    let signedPdfUrl = null;

    if (doc.file_url) {
      // Load original PDF
      const pdfRes = await fetch(doc.file_url);
      const existingPdfBytes = await pdfRes.arrayBuffer();
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();
      const lastPage = pages[pages.length - 1];
      const { width } = lastPage.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // KEY: signature_image_url is an HTTPS URL (uploaded by frontend) — fetch() works in Deno
      const imgRes = await fetch(signature_image_url);
      const sigImageBytes = new Uint8Array(await imgRes.arrayBuffer());
      const sigImage = await pdfDoc.embedPng(sigImageBytes);

      const sigW = 160, sigH = 60;
      const sigX = width - sigW - 40;
      const sigY = 60; // PDF coords: from bottom-left

      // Draw signature box
      lastPage.drawRectangle({
        x: sigX - 5, y: sigY - 18,
        width: sigW + 10, height: sigH + 28,
        color: rgb(0.97, 0.97, 0.97),
        borderColor: rgb(0.75, 0.75, 0.75),
        borderWidth: 0.5,
      });
      lastPage.drawImage(sigImage, { x: sigX, y: sigY, width: sigW, height: sigH });
      lastPage.drawLine({
        start: { x: sigX - 2, y: sigY - 2 },
        end: { x: sigX + sigW + 2, y: sigY - 2 },
        thickness: 0.7,
        color: rgb(0.4, 0.4, 0.4),
      });
      // IMPORTANT: English text only — Helvetica does not support Hebrew
      lastPage.drawText('Digital Signature', {
        x: sigX, y: sigY + sigH + 5,
        size: 7, font, color: rgb(0.65, 0.65, 0.65),
      });
      const dateStr = new Date().toLocaleDateString('en-GB');
      lastPage.drawText('Signed: ' + dateStr, {
        x: sigX, y: sigY - 18,
        size: 8, font, color: rgb(0.4, 0.4, 0.4),
      });

      const signedPdfBytes = await pdfDoc.save();
      const blob = new Blob([signedPdfBytes], { type: 'application/pdf' });
      const file = new File([blob], `signed_${(doc.name || 'document').replace(/\s/g, '_')}.pdf`, { type: 'application/pdf' });
      const uploadResult = await base44.asServiceRole.integrations.Core.UploadFile({ file });
      if (uploadResult?.file_url) signedPdfUrl = uploadResult.file_url;
    }

    // --- Update document ---
    await base44.asServiceRole.entities.Document.update(doc.id, {
      signature_status: 'signed',
      signed_at: signedAt,
      signer_name,
      signature_image_url,
      signed_pdf_url: signedPdfUrl,
    });

    // --- Log communication ---
    if (doc.client_id) {
      await base44.asServiceRole.entities.Communication.create({
        client_id: doc.client_id,
        project_id: doc.project_id || undefined,
        type: 'note',
        direction: 'inbound',
        content: `✍️ המסמך "${doc.name}" נחתם דיגיטלית על ידי ${signer_name} ב-${signedAtDisplay}`,
        sent_by: 'system',
        status: 'sent',
        channel: 'base44_native',
      });
    }

    // --- Notify admin via Brevo (not Gmail — Gmail OAuth expires) ---
    try {
      const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY');
      if (BREVO_API_KEY) {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: { name: 'סטודיו מיכל וולברגר', email: 'michalwol123@gmail.com' },
            to: [{ email: 'michalwol123@gmail.com' }],
            subject: `✍️ מסמך נחתם: ${doc.name}`,
            htmlContent: `<div dir="rtl" style="font-family:Arial,sans-serif;padding:20px;">
              <h2 style="color:#8B7355;">מסמך נחתם ✍️</h2>
              <p><strong>${doc.name}</strong> נחתם על ידי <strong>${signer_name}</strong> ב-${signedAtDisplay}</p>
              ${signedPdfUrl ? `<p style="margin-top:16px;"><a href="${signedPdfUrl}" style="background:#8B7355;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">צפה במסמך החתום ←</a></p>` : ''}
            </div>`
          })
        });
      }
    } catch (_) { /* notification failure should not block */ }

    return Response.json({ status: 'ok', signed_pdf_url: signedPdfUrl });
  } catch (err) {
    console.error('submitSignature error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
});
```

---

## 2. `base44/functions/getSignatureData/entry.ts`

```typescript
// Public function — returns document info for signature page
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const { token } = await req.json();
    const base44 = createClientFromRequest(req);
    if (!token) return Response.json({ error: 'missing_token' }, { status: 400 });

    let docs = await base44.asServiceRole.entities.Document.filter({ signature_token: token });
    if (!docs || docs.length === 0) {
      const pending = await base44.asServiceRole.entities.Document.filter({ signature_status: 'pending_signature' });
      docs = pending.filter(d => d.signature_token === token);
    }
    const doc = docs[0];
    if (!doc) return Response.json({ error: 'not_found' }, { status: 404 });
    if (doc.signature_status === 'signed') return Response.json({ error: 'already_signed' }, { status: 410 });

    let clientName = '';
    let projectName = '';
    if (doc.client_id) {
      const clients = await base44.asServiceRole.entities.Client.filter({ id: doc.client_id });
      clientName = clients[0]?.name || '';
    }
    if (doc.project_id) {
      const projects = await base44.asServiceRole.entities.Project.filter({ id: doc.project_id });
      projectName = projects[0]?.name || '';
    }

    return Response.json({
      doc_id: doc.id,
      name: doc.name,
      type: doc.type,
      file_url: doc.file_url,
      client_name: clientName,
      project_name: projectName,
    });
  } catch (err) {
    console.error('getSignatureData error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
});
```

---

## 3. `src/pages/SignDocument.jsx`

```jsx
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

export default function SignDocument() {
  const token = new URLSearchParams(window.location.search).get('token');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docData, setDocData] = useState(null);
  const [signerName, setSignerName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  const canvasRef = useRef(null);
  const isDrawing = useRef(false);
  const lastPos = useRef(null);

  useEffect(() => {
    if (!token) { setError('missing_token'); setLoading(false); return; }
    base44.functions.invoke('getSignatureData', { token })
      .then(res => {
        const data = res?.data || res;
        if (data?.error === 'already_signed') setError('already_signed');
        else if (data?.error) setError(data.error);
        else setDocData(data);
      })
      .catch(err => setError(err?.response?.data?.error || err?.message || 'unknown'))
      .finally(() => setLoading(false));
  }, [token]);

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (e.touches) return {
      x: (e.touches[0].clientX - rect.left) * scaleX,
      y: (e.touches[0].clientY - rect.top) * scaleY,
    };
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const startDraw = useCallback((e) => {
    e.preventDefault();
    isDrawing.current = true;
    const canvas = canvasRef.current;
    const pos = getPos(e, canvas);
    lastPos.current = pos;
    const ctx = canvas.getContext('2d');
    ctx.beginPath(); ctx.arc(pos.x, pos.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a1a'; ctx.fill();
  }, []);

  const draw = useCallback((e) => {
    if (!isDrawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const pos = getPos(e, canvas);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2.5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y); ctx.stroke();
    lastPos.current = pos;
    setHasSignature(true);
  }, []);

  const stopDraw = useCallback(() => { isDrawing.current = false; }, []);

  const clearCanvas = () => {
    canvasRef.current.getContext('2d').clearRect(0, 0, 500, 160);
    setHasSignature(false);
  };

  const handleSubmit = async () => {
    if (!signerName.trim()) { alert('נא להזין שם מלא'); return; }
    if (!agreed) { alert('נא לאשר שקראת את המסמך'); return; }
    if (!hasSignature) { alert('נא לחתום בתיבת החתימה'); return; }

    setSubmitting(true);
    try {
      // KEY: upload signature as PNG file to get HTTPS URL
      // Do NOT send data:URL — fetch(data:URL) does not work in Deno
      const canvas = canvasRef.current;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'signature.png', { type: 'image/png' });
      const { file_url } = await base44.integrations.Core.UploadFile({ file });

      await base44.functions.invoke('submitSignature', {
        token,
        signer_name: signerName.trim(),
        signature_image_url: file_url, // HTTPS URL, not base64
      });
      setSuccess(true);
    } catch (e) {
      alert('שגיאה בשמירת החתימה: ' + (e.message || 'נסה שוב'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#FAF8F5'}}><p style={{color:'#8B7355'}}>טוען מסמך...</p></div>;

  if (error) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#FAF8F5'}}>
      <div style={{textAlign:'center',padding:32,maxWidth:400}}>
        {error === 'already_signed'
          ? <><div style={{fontSize:52}}>✅</div><h2 style={{color:'#8B7355'}}>המסמך כבר נחתם</h2></>
          : <><div style={{fontSize:52}}>❌</div><h2 style={{color:'#c0392b'}}>{error === 'missing_token' ? 'קישור חסר' : 'מסמך לא נמצא'}</h2></>
        }
      </div>
    </div>
  );

  if (success) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#FAF8F5'}}>
      <div style={{textAlign:'center',padding:32,maxWidth:420,background:'white',borderRadius:16,boxShadow:'0 4px 24px rgba(0,0,0,0.08)'}}>
        <div style={{fontSize:60}}>✍️</div>
        <h2 style={{color:'#8B7355'}}>החתימה בוצעה בהצלחה!</h2>
        <p style={{color:'#555'}}>המסמך <strong>{docData?.name}</strong> נחתם.</p>
        <p style={{color:'#888',fontSize:14}}>תודה, {signerName}!</p>
      </div>
    </div>
  );

  if (!docData) return null;

  return (
    <div style={{minHeight:'100vh',background:'#FAF8F5',padding:'24px 16px',fontFamily:'Assistant, Arial, sans-serif',direction:'rtl'}}>
      <div style={{maxWidth:540,margin:'0 auto',background:'white',borderRadius:16,boxShadow:'0 4px 24px rgba(0,0,0,0.08)',overflow:'hidden'}}>
        <div style={{background:'#8B7355',padding:'20px 24px',color:'white'}}>
          <p style={{fontSize:11,opacity:0.7,margin:'0 0 4px'}}>Michal Wolberger Interior Design</p>
          <h1 style={{margin:0,fontSize:20}}>חתימה דיגיטלית</h1>
          <p style={{margin:'4px 0 0',opacity:0.85,fontSize:14}}>{docData.name}</p>
        </div>
        <div style={{padding:24}}>
          {docData.file_url && (
            <div style={{marginBottom:20,padding:'12px 16px',background:'#FAF8F5',borderRadius:8,border:'1px solid #e8e0d5'}}>
              <p style={{margin:'0 0 8px',fontSize:13,color:'#555'}}>לפני החתימה, מומלץ לעיין במסמך:</p>
              <a href={docData.file_url} target="_blank" rel="noopener noreferrer" style={{color:'#8B7355',fontWeight:600,fontSize:14,textDecoration:'none'}}>📄 פתח את המסמך לצפייה ←</a>
            </div>
          )}
          <div style={{marginBottom:20}}>
            <label style={{display:'block',fontSize:13,fontWeight:600,color:'#555',marginBottom:6}}>שם מלא *</label>
            <input style={{width:'100%',padding:'10px 12px',border:'1px solid #ddd',borderRadius:8,fontSize:15,direction:'rtl',boxSizing:'border-box'}}
              type="text" placeholder="הזן שם מלא" value={signerName} onChange={e => setSignerName(e.target.value)} />
          </div>
          <div style={{marginBottom:20}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <label style={{fontSize:13,fontWeight:600,color:'#555',margin:0}}>חתימה *</label>
              <button style={{fontSize:12,color:'#888',background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}} onClick={clearCanvas}>נקה</button>
            </div>
            <div style={{border:'2px solid #ddd',borderRadius:10,overflow:'hidden',background:'#fafafa',touchAction:'none'}}>
              <canvas ref={canvasRef} width={500} height={160}
                style={{width:'100%',height:160,display:'block',cursor:'crosshair'}}
                onMouseDown={startDraw} onMouseMove={draw} onMouseUp={stopDraw} onMouseLeave={stopDraw}
                onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={stopDraw} />
            </div>
            {!hasSignature && <p style={{fontSize:12,color:'#aaa',margin:'4px 0 0',textAlign:'center'}}>חתום כאן עם העכבר / האצבע</p>}
          </div>
          <div style={{marginBottom:20,display:'flex',alignItems:'flex-start',gap:10}}>
            <input type="checkbox" id="agree" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{marginTop:2,width:16,height:16,cursor:'pointer',flexShrink:0}} />
            <label htmlFor="agree" style={{fontSize:13,color:'#444',cursor:'pointer',lineHeight:1.5}}>
              קראתי את המסמך <strong>{docData.name}</strong> ומסכים/ה לתוכנו.
            </label>
          </div>
          <button style={{width:'100%',padding:13,background:submitting?'#b0997c':'#8B7355',color:'white',border:'none',borderRadius:10,fontSize:16,fontWeight:700,cursor:submitting?'default':'pointer',marginTop:16}}
            onClick={handleSubmit} disabled={submitting}>
            {submitting ? '⏳ שומר חתימה...' : '✍️ חתום ואשר מסמך'}
          </button>
          <p style={{fontSize:11,color:'#aaa',textAlign:'center',marginTop:12}}>החתימה הדיגיטלית מחייבת כחתימה על המסמך ותישמר במערכת.</p>
        </div>
      </div>
    </div>
  );
}
```
---

## גישה ב׳ — דף חתימה ציבורי (ללא login)

> השתמש בגישה זו כשהרוט `/sign` הוא public ולא דורש התחברות.
> **הבדל קריטי:** הdפדפן לא מעלה את החתימה — שולח base64 ישירות לbackend.

### `submitSignature/entry.ts` — גישה ב׳ (public page)

```typescript
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { PDFDocument, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const base44 = createClientFromRequest(req);
    const { token, signer_name, signature_data } = body; // base64, not URL

    if (!token || !signer_name || !signature_data) {
      return Response.json({ error: 'missing_fields' }, { status: 400 });
    }

    const docs = await base44.asServiceRole.entities.Document.filter({ signature_token: token });
    if (!docs?.length) return Response.json({ error: 'not_found' }, { status: 404 });
    const doc = docs[0];
    if (doc.signature_status === 'signed') return Response.json({ error: 'already_signed' }, { status: 410 });

    const signedAt = new Date().toISOString();
    const signedAtDisplay = new Date().toLocaleString('he-IL');

    let signedPdfUrl = doc.file_url;

    if (doc.file_url) {
      try {
        const pdfRes = await fetch(doc.file_url);
        if (!pdfRes.ok) throw new Error(`PDF fetch failed: ${pdfRes.status}`);

        const existingPdfBytes = await pdfRes.arrayBuffer();
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();
        const lastPage = pages[pages.length - 1];
        const { width } = lastPage.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        // KEY: decode base64 in backend — no browser upload needed (page is public)
        const base64Data = signature_data.includes(',') ? signature_data.split(',')[1] : signature_data;
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const sigImage = await pdfDoc.embedPng(bytes); // bytes directly, NOT bytes.buffer

        const sigW = 160, sigH = 60;
        const sigX = width - sigW - 40;
        const sigY = 60;

        lastPage.drawRectangle({
          x: sigX - 5, y: sigY - 18,
          width: sigW + 10, height: sigH + 28,
          color: rgb(0.97, 0.97, 0.97),
          borderColor: rgb(0.75, 0.75, 0.75),
          borderWidth: 0.5,
        });
        lastPage.drawImage(sigImage, { x: sigX, y: sigY, width: sigW, height: sigH });
        lastPage.drawLine({
          start: { x: sigX - 2, y: sigY - 2 },
          end: { x: sigX + sigW + 2, y: sigY - 2 },
          thickness: 0.7, color: rgb(0.4, 0.4, 0.4),
        });
        lastPage.drawText('Digital Signature', {
          x: sigX, y: sigY + sigH + 5,
          size: 7, font, color: rgb(0.65, 0.65, 0.65),
        });
        lastPage.drawText('Signed: ' + new Date().toLocaleDateString('en-GB'), {
          x: sigX, y: sigY - 14,
          size: 8, font, color: rgb(0.4, 0.4, 0.4),
        });

        const signedPdfBytes = await pdfDoc.save();
        const blob = new Blob([signedPdfBytes], { type: 'application/pdf' });
        const file = new File([blob], `signed_${(doc.name || 'document').replace(/\s/g, '_')}.pdf`, { type: 'application/pdf' });
        const uploadResult = await base44.asServiceRole.integrations.Core.UploadFile({ file });
        if (uploadResult?.file_url) signedPdfUrl = uploadResult.file_url;
      } catch (pdfErr) {
        console.error('PDF embedding failed:', pdfErr.message);
      }
    }

    await base44.asServiceRole.entities.Document.update(doc.id, {
      signature_status: 'signed',
      signed_at: signedAt,
      signer_name,
      signature_data,
      file_url: signedPdfUrl,
    });

    if (doc.contact_id) {
      await base44.asServiceRole.entities.Communication.create({
        contact_id: doc.contact_id,
        type: 'bot_event',
        direction: 'inbound',
        content: `מסמך "${doc.name}" נחתם דיגיטלית על ידי ${signer_name} ב-${signedAtDisplay}`,
        sent_by: 'system',
        is_automated: true,
        status: 'sent',
      });
    }

    return Response.json({ ok: true, file_url: signedPdfUrl });
  } catch (err) {
    console.error('submitSignature error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
});
```

### `SignDocument.jsx` — גישה ב׳ (public page, no upload)

הבדל יחיד מגישה א׳: `handleSubmit` שולח base64 ישירות.

```javascript
const handleSubmit = async () => {
  if (!signerName.trim()) { setError('נא להזין שם מלא לפני החתימה.'); return; }
  if (!hasSigned) { setError('נא לחתום בתיבת החתימה.'); return; }
  setError('');
  setSubmitting(true);
  try {
    // Send base64 directly — no UploadFile (page is public, no session)
    const signatureData = canvasRef.current.toDataURL('image/png');

    const res = await base44.functions.invoke('submitSignature', {
      token,
      signer_name: signerName.trim(),
      signature_data: signatureData,
    });

    if (res?.data?.ok) {
      setSignedFileUrl(res?.data?.file_url || null);
      setSubmitted(true);
    } else {
      setError(res?.data?.error === 'already_signed'
        ? 'המסמך כבר נחתם בעבר.'
        : 'שגיאה בשמירת החתימה. נסה שנית.');
    }
  } catch {
    setError('שגיאה בשמירת החתימה. נסה שנית.');
  } finally {
    setSubmitting(false);
  }
};
```
