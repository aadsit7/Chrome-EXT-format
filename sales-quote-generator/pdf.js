'use strict';

/* Minimal self-contained PDF writer + one-page quote layout.
   No external libraries (Manifest V3 forbids remote code) — the PDF is
   assembled directly from PDF operators using the built-in Helvetica fonts. */

(function () {

  /* ---- Helvetica metrics (AFM widths / 1000, chars 32..126) ---- */
  const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  // WinAnsi bytes for the typography the app uses; [byte, regWidth, boldWidth]
  const SPECIAL = {
    '’': [0x92, 222, 278], // ’
    '‘': [0x91, 222, 278], // ‘
    '“': [0x93, 333, 500], // “
    '”': [0x94, 333, 500], // ”
    '–': [0x96, 556, 556], // –
    '—': [0x97, 1000, 1000], // —
    '·': [0xb7, 278, 280], // ·
    '×': [0xd7, 584, 584], // ×
  };

  function normalize(s) {
    return String(s == null ? '' : s)
      .replace(/−/g, '-')   // math minus → hyphen
      .replace(/→/g, '-')   // → (billing schedule "Now → renewal")
      .replace(/∞/g, 'inf')
      .replace(/✓/g, '');
  }

  function encode(s) {
    let out = '';
    for (const ch of normalize(s)) {
      const code = ch.codePointAt(0);
      if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
      else if (code >= 32 && code <= 126) out += ch;
      else if (SPECIAL[ch]) out += '\\' + SPECIAL[ch][0].toString(8).padStart(3, '0');
      else out += '?';
    }
    return out;
  }

  function measure(s, size, bold) {
    let w = 0;
    for (const ch of normalize(s)) {
      const code = ch.codePointAt(0);
      if (code >= 32 && code <= 126) w += (bold ? W_BOLD : W_REG)[code - 32];
      else if (SPECIAL[ch]) w += SPECIAL[ch][bold ? 2 : 1];
      else w += 556;
    }
    return w * size / 1000;
  }

  /* ---- Tiny PDF document (US Letter, single page) ---- */
  const PAGE_W = 612, PAGE_H = 792;

  function PdfPage() {
    this.ops = [];
  }
  PdfPage.prototype.setFill = function (rgb) { this.ops.push(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' rg'); };
  PdfPage.prototype.setStroke = function (rgb) { this.ops.push(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' RG'); };
  // y is measured from the TOP of the page for all helpers below
  PdfPage.prototype.rect = function (x, y, w, hgt, rgb) {
    this.setFill(rgb);
    this.ops.push(x.toFixed(2) + ' ' + (PAGE_H - y - hgt).toFixed(2) + ' ' + w.toFixed(2) + ' ' + hgt.toFixed(2) + ' re f');
  };
  PdfPage.prototype.line = function (x1, y1, x2, y2, rgb, width) {
    this.setStroke(rgb);
    this.ops.push((width || 0.75) + ' w');
    this.ops.push(x1.toFixed(2) + ' ' + (PAGE_H - y1).toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + (PAGE_H - y2).toFixed(2) + ' l S');
  };
  PdfPage.prototype.text = function (str, x, y, opt) {
    opt = opt || {};
    const size = opt.size || 10;
    const bold = !!opt.bold;
    const font = opt.italic ? '/F3' : (bold ? '/F2' : '/F1');
    let tx = x;
    if (opt.align === 'right') tx = x - measure(str, size, bold);
    else if (opt.align === 'center') tx = x - measure(str, size, bold) / 2;
    this.setFill(opt.color || COLOR.text);
    const spacing = opt.tracking ? ' ' + opt.tracking + ' Tc' : ' 0 Tc';
    this.ops.push('BT' + spacing + ' ' + font + ' ' + size + ' Tf 1 0 0 1 ' + tx.toFixed(2) + ' ' + (PAGE_H - y).toFixed(2) + ' Tm (' + encode(str) + ') Tj ET');
  };
  PdfPage.prototype.textWidth = function (str, size, bold) { return measure(str, size, !!bold); };

  function buildPdf(page) {
    const content = page.ops.join('\n');
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
      '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
    });
    const xref = pdf.length;
    pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
    pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return bytes;
  }

  /* ---- Brand palette (mirrors app.css tokens) ---- */
  const hx = (s) => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255].map((n) => +n.toFixed(4));
  const COLOR = {
    accent: hx('#2563eb'),       // --accent
    accentSoft: hx('#e8f0fe'),   // --surface-accent-soft
    text: hx('#2a3142'),         // --text-primary
    strong: hx('#171d2b'),       // --text-strong
    secondary: hx('#5a6372'),    // --text-secondary
    tertiary: hx('#8a93a3'),     // --text-tertiary
    border: hx('#d5dae4'),       // --border-default
    subtle: hx('#e7eaf1'),       // --border-subtle
    sunken: hx('#eef1f6'),       // --surface-sunken
    green: hx('#16a34a'),        // --green-600
    white: [1, 1, 1],
  };

  /* ---- Quote layout ---- */
  const MARGIN = 48, RIGHT = PAGE_W - MARGIN, WIDTH = PAGE_W - 2 * MARGIN;

  function generateQuotePdf(data) {
    const p = new PdfPage();
    const meta = data.meta;
    let y = 0;

    /* Header */
    p.rect(0, 0, PAGE_W, 6, COLOR.accent);
    p.text('SALES TOOLS', MARGIN, 34, { size: 8, bold: true, color: COLOR.accent, tracking: 1 });
    p.text('Sales Quote', MARGIN, 56, { size: 22, bold: true, color: COLOR.strong });
    const pillText = meta.number;
    const pillW = p.textWidth(pillText, 10, false) + 20;
    p.rect(RIGHT - pillW, 40, pillW, 20, COLOR.sunken);
    p.text(pillText, RIGHT - pillW / 2, 54, { size: 10, align: 'center', color: COLOR.secondary });
    p.line(MARGIN, 70, RIGHT, 70, COLOR.subtle, 1);

    /* Meta row */
    y = 84;
    const metaCols = [
      ['DATE', meta.today],
      ['QUOTE EXPIRES', meta.expires || '—'],
      ['TERM', data.termLabel],
      ['PREPARED BY', meta.preparedBy || '—'],
    ];
    metaCols.forEach((mc, i) => {
      const x = MARGIN + (WIDTH / 4) * i;
      p.text(mc[0], x, y, { size: 6.5, bold: true, color: COLOR.tertiary, tracking: 0.5 });
      p.text(mc[1], x, y + 13, { size: 9.5, color: COLOR.text });
    });

    /* Parties */
    y = 122;
    if (meta.partnerActive) {
      p.text('BILL TO · PARTNER', MARGIN, y, { size: 6.5, bold: true, color: COLOR.accent, tracking: 0.5 });
      p.text(meta.partnerCompany || '—', MARGIN, y + 14, { size: 11, bold: true, color: COLOR.strong });
      p.text(meta.partnerEmail || '', MARGIN, y + 27, { size: 9, color: COLOR.secondary });
      p.text('SHIP TO · CUSTOMER', MARGIN + WIDTH / 2, y, { size: 6.5, bold: true, color: COLOR.tertiary, tracking: 0.5 });
      p.text(meta.customer || '—', MARGIN + WIDTH / 2, y + 14, { size: 11, bold: true, color: COLOR.strong });
      p.text(meta.email || '', MARGIN + WIDTH / 2, y + 27, { size: 9, color: COLOR.secondary });
    } else {
      p.text('PREPARED FOR', MARGIN, y, { size: 6.5, bold: true, color: COLOR.accent, tracking: 0.5 });
      p.text(meta.customer || '—', MARGIN, y + 14, { size: 11, bold: true, color: COLOR.strong });
      p.text(meta.email || '', MARGIN, y + 27, { size: 9, color: COLOR.secondary });
    }

    /* Line-item table */
    y = 168;
    p.rect(MARGIN, y, WIDTH, 18, COLOR.sunken);
    p.text('PRODUCT', MARGIN + 8, y + 12.5, { size: 7, bold: true, color: COLOR.tertiary, tracking: 0.5 });
    p.text('AMOUNT / YR', RIGHT - 8, y + 12.5, { size: 7, bold: true, color: COLOR.tertiary, align: 'right', tracking: 0.5 });
    y += 18;
    const MAX_ITEMS = 8;
    const items = data.items.slice(0, MAX_ITEMS);
    items.forEach((it) => {
      p.text(it.name, MARGIN + 8, y + 13, { size: 9.5, bold: true, color: COLOR.strong });
      p.text(it.qtyDisp, MARGIN + 8, y + 23, { size: 7.5, color: COLOR.tertiary });
      p.text(it.amt, RIGHT - 8, y + 16, { size: 9.5, color: COLOR.text, align: 'right' });
      y += 28;
      p.line(MARGIN, y, RIGHT, y, COLOR.subtle, 0.6);
    });
    if (data.items.length > MAX_ITEMS) {
      p.text('+ ' + (data.items.length - MAX_ITEMS) + ' more products (see calculator)', MARGIN + 8, y + 12, { size: 8, italic: true, color: COLOR.tertiary });
      y += 18;
    }

    /* Totals (right column) + billing schedule (left column) */
    y += 10;
    const blockTop = y;
    const totX = MARGIN + WIDTH * 0.48, totRight = RIGHT - 8;
    let ty = blockTop;
    data.totals.forEach((row) => {
      if (row.divider) { p.line(totX, ty + 3, totRight, ty + 3, COLOR.subtle, 0.6); ty += 8; return; }
      const size = row.bold ? 10 : 9;
      p.text(row.label, totX, ty + 10, { size, bold: !!row.bold, color: row.bold ? COLOR.strong : COLOR.secondary });
      p.text(row.amt, totRight, ty + 10, { size, bold: !!row.bold, align: 'right', color: row.green ? COLOR.green : (row.bold ? COLOR.strong : COLOR.text) });
      ty += 15;
    });

    let sy = blockTop;
    if (data.schedule.length > 0) {
      const schedW = WIDTH * 0.42;
      const MAX_SCHED = 6;
      const rows = data.schedule.slice(0, MAX_SCHED);
      const boxH = 22 + rows.length * 14 + (data.schedule.length > MAX_SCHED ? 12 : 0);
      p.rect(MARGIN, sy, schedW, boxH, COLOR.sunken);
      p.text('BILLING SCHEDULE', MARGIN + 10, sy + 14, { size: 6.5, bold: true, color: COLOR.tertiary, tracking: 0.5 });
      let ry = sy + 28;
      rows.forEach((yr) => {
        p.text(yr.label, MARGIN + 10, ry, { size: 8.5, color: COLOR.secondary });
        p.text(yr.amt, MARGIN + schedW - 10, ry, { size: 8.5, align: 'right', color: COLOR.text });
        ry += 14;
      });
      if (data.schedule.length > MAX_SCHED) {
        p.text('+ ' + (data.schedule.length - MAX_SCHED) + ' more periods', MARGIN + 10, ry, { size: 7.5, italic: true, color: COLOR.tertiary });
      }
      sy += boxH;
    }
    y = Math.max(ty, sy) + 14;

    /* Total contract value band */
    const bandH = 52;
    p.rect(MARGIN, y, WIDTH, bandH, COLOR.accentSoft);
    p.text(data.tcvLabel.toUpperCase(), MARGIN + 14, y + 15, { size: 7, bold: true, color: COLOR.accent, tracking: 0.8 });
    p.text(data.tcv, MARGIN + 14, y + 38, { size: 20, bold: true, color: COLOR.strong });
    p.text(data.tcvSub, RIGHT - 14, y + 20, { size: 8, align: 'right', color: COLOR.secondary });
    if (data.savings) {
      p.text('Customer saves vs list: -' + data.savings.amt + ' (' + data.savings.pct + '%)', RIGHT - 14, y + 38, { size: 9, bold: true, align: 'right', color: COLOR.green });
    }
    y += bandH + 12;

    /* Partner breakdown */
    if (data.partner) {
      const rows = [
        ['List price · TCV', data.partner.msrpTcv, COLOR.text, false],
        ['Partner savings', '-' + data.partner.savings, COLOR.green, false],
        ['Partner pays', data.partner.pays, COLOR.strong, true],
      ];
      rows.forEach((rw) => {
        p.text(rw[0], totX, y + 9, { size: 9, bold: rw[3], color: rw[3] ? COLOR.strong : COLOR.secondary });
        p.text(rw[1], totRight, y + 9, { size: 9, bold: rw[3], align: 'right', color: rw[2] });
        y += 14;
      });
      y += 6;
    }

    /* Signature section — anchored near the bottom of the page */
    let sigY = Math.min(Math.max(y + 18, 600), 620);
    p.line(MARGIN, sigY, RIGHT, sigY, COLOR.subtle, 1);
    sigY += 16;
    p.text('ACCEPTANCE', MARGIN, sigY, { size: 7, bold: true, color: COLOR.tertiary, tracking: 0.8 });
    p.text('By signing below, both parties agree to the products, pricing, and term shown on this quote.', MARGIN, sigY + 12, { size: 7.5, color: COLOR.secondary });
    sigY += 30;
    const colW = WIDTH / 2 - 16;
    const signer = meta.partnerActive ? (meta.partnerCompany || 'Partner') : (meta.customer || 'Customer');
    const cols = [
      { x: MARGIN, header: 'ACCEPTED BY · ' + signer.toUpperCase(), printed: '' },
      { x: MARGIN + WIDTH / 2 + 16, header: 'PRESENTED BY · SALES TEAM', printed: meta.preparedBy || '' },
    ];
    cols.forEach((c) => {
      p.text(c.header, c.x, sigY, { size: 6.5, bold: true, color: COLOR.tertiary, tracking: 0.5 });
      let ly = sigY + 30;
      p.line(c.x, ly, c.x + colW, ly, COLOR.border, 0.8);
      p.text('Signature', c.x, ly + 9, { size: 7, color: COLOR.tertiary });
      ly += 28;
      p.line(c.x, ly, c.x + colW, ly, COLOR.border, 0.8);
      if (c.printed) p.text(c.printed, c.x, ly - 4, { size: 9, color: COLOR.text });
      p.text('Name & title', c.x, ly + 9, { size: 7, color: COLOR.tertiary });
      ly += 28;
      p.line(c.x, ly, c.x + colW * 0.6, ly, COLOR.border, 0.8);
      p.text('Date', c.x, ly + 9, { size: 7, color: COLOR.tertiary });
    });

    /* Footer */
    p.text('Estimate only, not a formal quote · USD, billed annually · Pricing follows the rates configured in settings', PAGE_W / 2, PAGE_H - 16, { size: 7, align: 'center', color: COLOR.tertiary });

    return buildPdf(p);
  }

  function downloadQuotePdf(data) {
    const bytes = generateQuotePdf(data);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.meta.number + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  window.SQG_PDF = { downloadQuotePdf, generateQuotePdf };
})();
