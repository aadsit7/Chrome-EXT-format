'use strict';

/* Minimal self-contained PDF writer + one-page quote layout.
   No external libraries (Manifest V3 forbids remote code) — the PDF is
   assembled directly from PDF operators using the built-in Helvetica fonts,
   plus the bundled Recast logo embedded as a raster XObject at runtime.
   Layout replicates the Recast quote template exactly (coordinates, colors,
   section bars, product table, totals, terms, and signature block). */

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
    '…': [0x85, 1000, 1000], // … (ellipsis used when a value is clipped at its column edge)
  };

  function normalize(s) {
    return String(s == null ? '' : s)
      .replace(/−/g, '-')   // math minus → hyphen
      .replace(/→/g, '-')
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
    this.images = [];
    this.texts = []; // structured record of every drawn string (for layout tests)
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
    const font = bold ? '/F2' : '/F1';
    const w = measure(str, size, bold);
    let tx = x;
    if (opt.align === 'right') tx = x - w;
    else if (opt.align === 'center') tx = x - w / 2;
    this.setFill(opt.color || COLOR.body);
    this.ops.push('BT ' + font + ' ' + size + ' Tf 1 0 0 1 ' + tx.toFixed(2) + ' ' + (PAGE_H - y).toFixed(2) + ' Tm (' + encode(str) + ') Tj ET');
    // Record the placed glyph box (x0..x0+w, baseline y) so the test harness can
    // assert zero overlaps / zero column overflows without re-parsing the stream.
    if (String(str).length) this.texts.push({ str: String(str), x: tx, y: y, w: w, size: size, bold: bold });
  };
  PdfPage.prototype.textWidth = function (str, size, bold) { return measure(str, size, !!bold); };
  // Draws a bundled raster image; x/y (top-down, top-left corner) and w/h in points.
  PdfPage.prototype.image = function (img, x, y, w, h) {
    if (!img) return;
    const name = 'Im' + (this.images.length + 1);
    this.images.push({ name: name, width: img.width, height: img.height, rgb: img.rgb, alpha: img.alpha });
    const by = PAGE_H - y - h;
    this.ops.push('q ' + w.toFixed(3) + ' 0 0 ' + h.toFixed(3) + ' ' + x.toFixed(3) + ' ' + by.toFixed(3) + ' cm /' + name + ' Do Q');
  };

  /* ---- Byte-accurate assembler (supports binary image streams) ---- */
  function ByteWriter() { this.chunks = []; this.length = 0; }
  ByteWriter.prototype.str = function (s) {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
    this.chunks.push(buf);
    this.length += buf.length;
  };
  ByteWriter.prototype.bytes = function (b) { this.chunks.push(b); this.length += b.length; };
  ByteWriter.prototype.toBytes = function () {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  };

  function buildPdf(page) {
    const content = page.ops.join('\n');
    const w = new ByteWriter();
    w.str('%PDF-1.4\n');
    const offsets = [];
    function beginObj(num) { offsets[num] = w.length; w.str(num + ' 0 obj\n'); }
    function endObj() { w.str('\nendobj\n'); }

    const fontF1 = 4, fontF2 = 5;
    let nextNum = 6;
    const contentNum = nextNum++;
    const imgs = page.images.map((im) => {
      const imgNum = nextNum++;
      const smaskNum = im.alpha ? nextNum++ : 0;
      return Object.assign({ imgNum: imgNum, smaskNum: smaskNum }, im);
    });

    beginObj(1); w.str('<< /Type /Catalog /Pages 2 0 R >>'); endObj();
    beginObj(2); w.str('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); endObj();

    const xobjDict = imgs.length
      ? (' /XObject << ' + imgs.map((im) => '/' + im.name + ' ' + im.imgNum + ' 0 R').join(' ') + ' >>')
      : '';
    beginObj(3);
    w.str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 ' +
      fontF1 + ' 0 R /F2 ' + fontF2 + ' 0 R >>' + xobjDict + ' >> /Contents ' + contentNum + ' 0 R >>');
    endObj();

    beginObj(fontF1); w.str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); endObj();
    beginObj(fontF2); w.str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); endObj();

    beginObj(contentNum);
    w.str('<< /Length ' + content.length + ' >>\nstream\n');
    w.str(content);
    w.str('\nendstream');
    endObj();

    imgs.forEach((im) => {
      beginObj(im.imgNum);
      w.str('<< /Type /XObject /Subtype /Image /Width ' + im.width + ' /Height ' + im.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8' + (im.smaskNum ? ' /SMask ' + im.smaskNum + ' 0 R' : '') +
        ' /Length ' + im.rgb.length + ' >>\nstream\n');
      w.bytes(im.rgb);
      w.str('\nendstream');
      endObj();
      if (im.smaskNum) {
        beginObj(im.smaskNum);
        w.str('<< /Type /XObject /Subtype /Image /Width ' + im.width + ' /Height ' + im.height +
          ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ' + im.alpha.length + ' >>\nstream\n');
        w.bytes(im.alpha);
        w.str('\nendstream');
        endObj();
      }
    });

    const xrefOffset = w.length;
    const totalObjs = nextNum - 1;
    w.str('xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n');
    for (let i = 1; i <= totalObjs; i++) w.str(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    w.str('trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF');
    return w.toBytes();
  }

  /* ---- Brand palette (exact values from the Recast quote template) ---- */
  const hx = (s) => [s.slice(1, 3), s.slice(3, 5), s.slice(5, 7)].map((h) => +(parseInt(h, 16) / 255).toFixed(4));
  const COLOR = {
    dark: hx('#3C3C3C'),    // section bars
    navy: hx('#1A1A2E'),    // headlines / labels
    body: hx('#333333'),    // value text
    link: hx('#0000CC'),    // Recast primary blue (hyperlinks)
    slate: hx('#4A4A5A'),   // acceptance intro sentence
    hair: hx('#CCCCCC'),    // hairline rules
    white: [1, 1, 1],
  };

  /* ---- Layout constants (points; all extracted from the reference template) ---- */
  const L = 24, R = 588;              // content left/right margins
  const BAR_L = 12, BAR_W = 588;      // section bar inset (full-bleed-ish, 12pt margin)

  const BAR_H = 15; // section bar height

  function drawSectionBar(p, topY, title) {
    p.rect(BAR_L, topY, BAR_W, BAR_H, COLOR.dark);
    p.text(title, 20, topY + 10.5, { size: 8.5, color: COLOR.white });
    return topY + BAR_H;
  }

  // Trim a string until it plus an ellipsis fits maxWidth at the given size —
  // the hard column edge when even the floor size can't shrink it enough.
  function clipToWidth(p, str, size, bold, maxWidth) {
    const ell = '…';
    if (maxWidth <= 0) return '';
    if (p.textWidth(ell, size, bold) > maxWidth) return '';
    let s = String(str);
    while (s.length && p.textWidth(s + ell, size, bold) > maxWidth) s = s.slice(0, -1);
    s = s.replace(/\s+$/, '');
    return s ? s + ell : ell;
  }

  // HARD COLUMN RULE: a value may never render past maxWidth into a neighbouring
  // label or column. Shrink toward the floor first (as before); if it still
  // doesn't fit at the floor, truncate with an ellipsis at the column edge.
  // Returns the size actually used (for callers / tests that want it).
  function fitText(p, str, x, y, maxWidth, baseSize, color, opts) {
    opts = opts || {};
    const bold = !!opts.bold;
    const floor = opts.floor || 6.5;
    str = String(str == null ? '' : str);
    let size = baseSize;
    while (size > floor && p.textWidth(str, size, bold) > maxWidth) size -= 0.25;
    if (p.textWidth(str, size, bold) > maxWidth) str = clipToWidth(p, str, size, bold, maxWidth);
    p.text(str, x, y, { size: size, bold: bold, color: color, align: opts.align });
    return size;
  }

  // Greedy word-wrap of free-text (address) fields; preserves user blank lines.
  function wrapPlainLines(p, text, width, size) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return [];
    const rawLines = raw.split(/\r\n|\r|\n/);
    const out = [];
    rawLines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) { out.push(''); return; }
      const words = trimmed.split(/\s+/);
      let cur = '';
      words.forEach((wd) => {
        const test = cur ? cur + ' ' + wd : wd;
        if (cur && p.textWidth(test, size, false) > width) { out.push(cur); cur = wd; }
        else cur = test;
      });
      if (cur) out.push(cur);
    });
    return out;
  }

  const LINE_H = 11; // address / label row height

  // How many lines drawAddressBlock will occupy for the given content — used by
  // computeLayout so the block takes ONLY the height it actually uses (dead space
  // collapses). Mirrors the draw loop below exactly.
  function blockLineCount(addrLen, extrasLen, maxLines) {
    maxLines = maxLines || 8;
    let used = 1; // the name line is always present
    const addrRoom = Math.max(0, maxLines - used - extrasLen);
    used += Math.min(addrLen, addrRoom);
    used += Math.min(extrasLen, Math.max(0, maxLines - used));
    return used;
  }

  function drawAddressBlock(p, name, addrLines, extras, x, startY, width, maxLines) {
    // Draws: the name, then address lines, then any labeled extra lines (e.g. a
    // Contact and an Email line). Everything is capped to maxLines TOTAL (name
    // included); room for the extras is reserved first, so they are never dropped
    // for a long address. Every line is clipped to `width` (hard column rule).
    // Returns the y just past the last drawn line (the block's true bottom).
    extras = (extras || []).filter((s) => s);
    maxLines = maxLines || 8;
    fitText(p, name || '', x, startY, width, 8.5, COLOR.body); // line 0 = name
    let y = startY + LINE_H;
    let used = 1;
    const addrRoom = Math.max(0, maxLines - used - extras.length);
    let drawn = 0;
    for (let i = 0; i < addrLines.length && drawn < addrRoom; i++) {
      if (addrLines[i]) fitText(p, addrLines[i], x, y, width, 8.5, COLOR.body);
      y += LINE_H; drawn++; used++;
    }
    extras.forEach((ex) => {
      if (used >= maxLines) return;
      fitText(p, ex, x, y, width, 8.5, COLOR.body);
      y += LINE_H; used++;
    });
    return y;
  }

  /* ---- Terms & Conditions: fixed copy, tokenized so links render inline ---- */
  function tokenize(str) {
    const parts = str.split(' ');
    const out = [];
    parts.forEach((word, i) => {
      const spacer = i < parts.length - 1 ? ' ' : '';
      const m = /^(https?:\/\/[^\s.,;:]+)([.,;:]?)$/.exec(word);
      if (m) {
        out.push({ t: m[1], link: true });
        if (m[2] || spacer) out.push({ t: m[2] + spacer });
      } else {
        out.push({ t: word + spacer });
      }
    });
    return out;
  }
  const TERMS_PARA_1 = tokenize(
    "This Quote Form is governed by Recast Software, Inc.'s Terms of Service, available online at: " +
    'https://recastsoftware.com/terms-of-service and Recast Software, Inc.\'s Privacy Policy, available online at ' +
    'https://recastsoftware.com/privacy-policy.'
  );
  const TERMS_PARA_2 = tokenize(
    "Prices shown above do not include any taxes that may apply. Any such taxes are the responsibility of the " +
    'Customer and will appear on the final invoice. For customers based in the United States, any applicable ' +
    "taxes will be determined based on the laws and regulations of the taxing authority(ies) governing the " +
    "'Ship To' location provided by Customer on the final invoice."
  );

  function wrapTokens(p, tokens, size, width, indent) {
    const lines = [];
    let cur = [], curW = 0, first = true;
    tokens.forEach((tok) => {
      const w = p.textWidth(tok.t, size, false);
      const avail = width - (first ? indent : 0);
      if (cur.length && curW + w > avail) { lines.push(cur); cur = []; curW = 0; first = false; }
      cur.push(tok); curW += w;
    });
    if (cur.length) lines.push(cur);
    return lines;
  }

  function drawTokenLines(p, lines, x, startY, indent, size, leading) {
    let y = startY;
    lines.forEach((line, i) => {
      let lx = x + (i === 0 ? indent : 0);
      line.forEach((tok) => {
        const color = tok.link ? COLOR.link : COLOR.body;
        p.text(tok.t, lx, y, { size: size, color: color });
        const w = p.textWidth(tok.t, size, false);
        if (tok.link) {
          const uw = p.textWidth(tok.t.replace(/\s+$/, ''), size, false);
          p.line(lx, y + size * 0.158, lx + uw, y + size * 0.158, COLOR.link, 0.4);
        }
        lx += w;
      });
      if (i < lines.length - 1) y += leading;
    });
    return y;
  }

  /* ---- Product table + totals ---- */
  const PROD_BAR_H = 17; // product-table header bar height

  function drawProductHeader(p, topY) {
    p.rect(BAR_L, topY, BAR_W, PROD_BAR_H, COLOR.dark);
    const baseline = topY + 12;
    p.text('Product Name', 22, baseline, { size: 9, bold: true, color: COLOR.white });
    p.text('Start Date', 300, baseline, { size: 9, bold: true, color: COLOR.white, align: 'right' });
    p.text('End Date', 400, baseline, { size: 9, bold: true, color: COLOR.white, align: 'right' });
    p.text('Quantity', 505, baseline, { size: 9, bold: true, color: COLOR.white, align: 'right' });
    p.text('Total', 588, baseline, { size: 9, bold: true, color: COLOR.white, align: 'right' });
    return topY + PROD_BAR_H;
  }

  function drawProductRow(p, rowTop, item) {
    const baseline = rowTop + 16;
    fitText(p, item.name || '', 30, baseline, 220, 8.5, COLOR.body);
    p.text(item.start || '', 300, baseline, { size: 8.5, color: COLOR.body, align: 'right' });
    p.text(item.end || '', 400, baseline, { size: 8.5, color: COLOR.body, align: 'right' });
    p.text(item.qty || '', 505, baseline, { size: 8.5, color: COLOR.body, align: 'right' });
    p.text(item.total || '', 588, baseline, { size: 8.5, color: COLOR.body, align: 'right' });
    p.line(20, rowTop + 28, 592, rowTop + 28, COLOR.hair, 0.5);
  }

  function drawTotals(p, thinRuleY, taxesY, grandY, grandTotal) {
    p.line(500, thinRuleY, 588, thinRuleY, COLOR.navy, 0.8);
    p.text('Taxes', 492, taxesY, { size: 9, bold: true, color: COLOR.navy, align: 'right' });
    p.text('Not Included', 588, taxesY, { size: 9, bold: true, color: COLOR.navy, align: 'right' });
    p.text('Grand Total', 492, grandY, { size: 9, bold: true, color: COLOR.navy, align: 'right' });
    p.text(grandTotal || '', 588, grandY, { size: 9, color: COLOR.navy, align: 'right' });
  }

  function drawTerms(p, barTopY, size, leading, paraGap, lines1, lines2) {
    drawSectionBar(p, barTopY, 'Terms & Conditions');
    const startY = barTopY + 15 + 16;
    const last1 = drawTokenLines(p, lines1, L, startY, 10, size, leading);
    const start2 = last1 + paraGap;
    drawTokenLines(p, lines2, L, start2, 10, size, leading);
  }

  function drawSignatures(p, barTopY) {
    drawSectionBar(p, barTopY, 'Acceptance & Signatures');
    const introY = barTopY + 15 + 15;
    p.text('By signing below, each party agrees to the terms of this Quote Form, including the Terms & Conditions referenced above.',
      L, introY, { size: 7.6, color: COLOR.slate });
    const headerY = introY + 25;
    p.text('Customer', L, headerY, { size: 8.8, bold: true, color: COLOR.navy });
    p.text('Recast Software, Inc.', 330, headerY, { size: 8.8, bold: true, color: COLOR.navy });
    const rows = ['Signature', 'Name', 'Title', 'Date'];
    let y = headerY + 24;
    rows.forEach((label) => {
      p.text(label, L, y, { size: 8, color: COLOR.body });
      p.line(76, y + 1.5, 282, y + 1.5, COLOR.navy, 0.6);
      p.text(label, 330, y, { size: 8, color: COLOR.body });
      p.line(382, y + 1.5, 588, y + 1.5, COLOR.navy, 0.6);
      y += 24;
    });
  }

  function drawHeader(p, logoImg, meta) {
    if (logoImg) p.image(logoImg, 22, 28, 118, 28.254);
    const lines = [
      ['Recast Software, Inc.', 9, 34],
      ['40 S 7th St', 7.5, 46],
      ['Suite 212 – Mailbox 207', 7.5, 57],
      ['Minneapolis, MN 55402', 7.5, 68],
      ['United States', 7.5, 79],
    ];
    lines.forEach((row) => p.text(row[0], R, row[2], { size: row[1], bold: true, align: 'right', color: COLOR.navy }));
    p.text('Quote Number: ' + (meta.number || ''), L, 106, { size: 10.5, bold: true, color: COLOR.navy });
    return 106; // quote-number baseline — the flow below starts a gap under this
  }

  // Bill/Ship parties. Flows from lay.partiesTop: the address blocks take only the
  // height they use, and the Prepared By / Auto Renewal rows sit below whichever
  // block is taller (lay.preparedRowY / lay.autoRenewRowY, precomputed the same
  // way in computeLayout). Returns the section's bottom y.
  function drawParties(p, meta, billLines, shipLines, lay) {
    const top = lay.partiesTop, maxL = lay.blockMaxLines;
    p.text('Bill To', L, top, { size: 8.5, bold: true, color: COLOR.navy });
    p.text('Address', L, top + LINE_H, { size: 8.5, bold: true, color: COLOR.navy });
    p.text('Ship To', 352, top, { size: 8.5, bold: true, color: COLOR.navy });
    p.text('Address', 352, top + LINE_H, { size: 8.5, bold: true, color: COLOR.navy });

    // Bill To also carries the person (Contact) and the relevant email, so a
    // reader sees who / where to invoice. On a partner deal the bill-to party is
    // the reseller, so its email is the partner email; otherwise the contact email.
    const billContact = meta.billingContact ? ('Contact: ' + meta.billingContact) : '';
    const billEmailVal = meta.partnerActive ? meta.partnerEmail : meta.email;
    const billEmail = billEmailVal ? ('Email: ' + billEmailVal) : '';

    drawAddressBlock(p, meta.billToName, billLines, [billContact, billEmail], 172, top, 170, maxL);
    drawAddressBlock(p, meta.shipToName, shipLines, [], 460, top, 128, maxL);

    const pr = lay.preparedRowY, ar = lay.autoRenewRowY;
    p.text('Prepared By', L, pr, { size: 8.5, bold: true, color: COLOR.navy });
    fitText(p, meta.preparedBy || '', 172, pr, 170, 8.5, COLOR.body);
    p.text('Billing Frequency', 352, pr, { size: 8.5, bold: true, color: COLOR.navy });
    fitText(p, meta.billingFrequency || '', 460, pr, 128, 8.5, COLOR.body);

    p.text('Auto Renewal', L, ar, { size: 8.5, bold: true, color: COLOR.navy });
    fitText(p, meta.autoRenewal || '', 172, ar, 170, 8.5, COLOR.body);
    p.text('Expiration Date', 352, ar, { size: 8.5, bold: true, color: COLOR.navy });
    fitText(p, meta.expiresDisp || '', 460, ar, 128, 8.5, COLOR.body);
    return lay.partiesBottom;
  }

  function drawOrderDetails(p, meta, lay) {
    drawSectionBar(p, lay.odBarTop, 'Order Details');
    // Row 1 — Billing Contact + Payment Method
    p.text('Billing Contact', L, lay.odRow1, { size: 8.5, color: COLOR.body });
    fitText(p, meta.billingContact || '', 214, lay.odRow1, 136, 8.5, COLOR.body);
    p.text('Payment Method', 360, lay.odRow1, { size: 8.5, color: COLOR.body });
    fitText(p, meta.paymentMethod || '', 500, lay.odRow1, 100, 8.5, COLOR.body, { floor: 6 });
    p.line(20, lay.odHair1, 592, lay.odHair1, COLOR.hair, 0.5);
    // Row 2 — Email + Currency
    p.text('Email', L, lay.odRow2, { size: 8.5, color: COLOR.body });
    fitText(p, meta.email || '', 214, lay.odRow2, 136, 8.5, COLOR.body, { floor: 6 });
    p.text('Currency', 360, lay.odRow2, { size: 8.5, color: COLOR.body });
    fitText(p, meta.currency || '', 500, lay.odRow2, 100, 8.5, COLOR.body);
    p.line(20, lay.odHair2, 592, lay.odHair2, COLOR.hair, 0.5);
    // Row 3 — Payment Terms
    p.text('Payment Terms', L, lay.odRow3, { size: 8.5, color: COLOR.body });
    fitText(p, meta.paymentTerms || '', 214, lay.odRow3, 136, 8.5, COLOR.body);
    p.line(20, lay.odHair3, 592, lay.odHair3, COLOR.hair, 0.5);
    return lay.orderBottom;
  }

  /* ---- Bundled logo: decoded once via canvas into raw RGB + alpha planes ---- */
  let logoPromise = null;
  function loadLogoImage() {
    if (!logoPromise) {
      logoPromise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const n = canvas.width * canvas.height;
            const rgb = new Uint8Array(n * 3);
            const alpha = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2];
              alpha[i] = px[i * 4 + 3];
            }
            resolve({ width: canvas.width, height: canvas.height, rgb: rgb, alpha: alpha });
          } catch (e) { reject(e); }
        };
        img.onerror = reject;
        img.src = chrome.runtime.getURL('assets/recast-logo.png');
      });
    }
    return logoPromise;
  }

  /* ---- Flow-based full-page layout with deterministic one-page compression ----
     Every section is placed relative to where the previous one actually finished,
     so partner quotes (more content in the same slots) and direct quotes both lay
     out cleanly and the Bill To / Ship To dead space collapses. If the flowed
     document would exceed the page, it is compressed in a fixed order — (a) the
     inter-section gaps, (b) the Terms line leading, (c) the Terms font down to a
     6pt floor — never dropping content and never spilling to a second page. */
  const BOTTOM_LIMIT = 772;   // last signature rule must land above this
  const PROD_ROW_H = 28;      // product-table row height

  // Six compressible inter-section gaps: [default, floor]. gapScale 1 → default,
  // gapScale 0 → floor. Everything else (bar heights, row pitches) is fixed.
  const GAPS = {
    hp: [32, 12],  // header (quote number) → parties
    po: [17, 8],   // parties bottom → Order Details bar
    op: [12, 6],   // Order Details → product-table header bar
    tt: [40, 16],  // product table bottom → totals thin rule
    tg: [17, 8],   // grand total → Terms bar
    ts: [19, 8],   // Terms bottom → Acceptance & Signatures bar
  };

  function computeLayout(p, o) {
    const s = o.gapScale;
    const gp = (k) => GAPS[k][1] + (GAPS[k][0] - GAPS[k][1]) * s;

    // ---- top flow: header → parties (address blocks collapse to used height) ----
    const headerBottom = 106;                       // quote-number baseline
    const partiesTop = headerBottom + gp('hp');
    const billLC = blockLineCount(o.billLines.length, o.billExtras, o.blockMaxLines);
    const shipLC = blockLineCount(o.shipLines.length, o.shipExtras, o.blockMaxLines);
    const blockLines = Math.max(billLC, shipLC, 2); // ≥2 so both labels have room
    const blockBottom = partiesTop + blockLines * LINE_H;
    const preparedRowY = blockBottom + 6;           // Prepared By / Billing Frequency
    const autoRenewRowY = preparedRowY + 16;        // Auto Renewal / Expiration Date
    const partiesBottom = autoRenewRowY + 6;

    // ---- Order Details ----
    const odBarTop = partiesBottom + gp('po');
    const odRow1 = odBarTop + BAR_H + 14;
    const odHair1 = odRow1 + 5;
    const odRow2 = odRow1 + 16;
    const odHair2 = odRow2 + 5;
    const odRow3 = odRow2 + 16;
    const odHair3 = odRow3 + 5;
    const orderBottom = odHair3;

    // ---- product table ----
    const phBarTop = orderBottom + gp('op');
    const rowTop0 = phBarTop + PROD_BAR_H;
    const tableBottom = rowTop0 + (o.rowCount + o.noteRow) * PROD_ROW_H;

    // ---- totals ----
    const thinRule = tableBottom + gp('tt');
    const taxesY = thinRule + 12;
    const grandY = taxesY + 20;

    // ---- Terms & Conditions ----
    const termsSize = o.termsSize;
    const leading = termsSize * (o.leadFactor / 7.6);
    const paraGap = termsSize * (16 / 7.6);
    const width = R - L, indent = 10;
    const lines1 = wrapTokens(p, TERMS_PARA_1, termsSize, width, indent);
    const lines2 = wrapTokens(p, TERMS_PARA_2, termsSize, width, indent);
    const termsBarTop = grandY + gp('tg');
    const termsStart = termsBarTop + BAR_H + 16;
    const termsLast1 = termsStart + (lines1.length - 1) * leading;
    const termsStart2 = termsLast1 + paraGap;
    const termsLast2 = termsStart2 + (lines2.length - 1) * leading;

    // ---- Acceptance & Signatures ----
    const acceptBarTop = termsLast2 + gp('ts');
    const introY = acceptBarTop + BAR_H + 15;
    const headerY = introY + 25;
    const lastRuleY = headerY + 24 * 4 + 1.5;

    return {
      partiesTop, blockMaxLines: o.blockMaxLines, preparedRowY, autoRenewRowY, partiesBottom,
      odBarTop, odRow1, odHair1, odRow2, odHair2, odRow3, odHair3, orderBottom,
      phBarTop, rowTop0, tableBottom, thinRule, taxesY, grandY,
      termsSize, leading, paraGap, lines1, lines2, termsBarTop, acceptBarTop, lastRuleY,
    };
  }

  // Compute the fitted layout for a quote (pure measurement — no drawing). Returns
  // everything the draw pass and the test harness need. `p` accumulates no draw
  // ops here (wrap/measure only), so the same page is safe to draw on afterward.
  function planQuote(p, data) {
    const meta = data.meta || {};
    const billLines = wrapPlainLines(p, meta.billToAddress, 170, 8.5).slice(0, 9);
    const shipLines = wrapPlainLines(p, meta.shipToAddress, 128, 8.5).slice(0, 9);
    const billExtras = (meta.billingContact ? 1 : 0) + ((meta.partnerActive ? meta.partnerEmail : meta.email) ? 1 : 0);
    const blockMaxLines = 9;

    const items = (data.items || []).slice(0, 20);
    let rowCount = items.length;
    let overflow = items.length - rowCount;
    let noteRow = overflow > 0 ? 1 : 0;

    const base = { billLines, shipLines, billExtras, shipExtras: 0, blockMaxLines };
    let s = 1, lf = 10.4, ts = 7.6;
    const build = () => computeLayout(p, Object.assign({}, base, { rowCount, noteRow, gapScale: s, leadFactor: lf, termsSize: ts }));
    let layout = build();
    const fits = () => layout.lastRuleY <= BOTTOM_LIMIT;
    // (a) inter-section gaps → (b) Terms leading → (c) Terms font (6pt floor).
    while (!fits() && s > 0) { s = Math.max(0, +(s - 0.1).toFixed(2)); layout = build(); }
    while (!fits() && lf > 8.6) { lf = +(lf - 0.2).toFixed(2); layout = build(); }
    while (!fits() && ts > 6.0) { ts = +(ts - 0.2).toFixed(2); layout = build(); }
    // Safety valve for a pathological product count only (compressions run first):
    // fold the tail into a "+N more" note so a quote can never reach a 2nd page.
    while (!fits() && rowCount > 1) { rowCount -= 1; overflow = items.length - rowCount; noteRow = overflow > 0 ? 1 : 0; layout = build(); }

    return { meta, billLines, shipLines, items, rowCount, noteRow, overflow, layout };
  }

  // Draw the whole quote onto p using a pre-computed plan (logoImg may be null).
  function drawQuote(p, logoImg, data, plan) {
    const { meta, billLines, shipLines, items, rowCount, noteRow, overflow, layout } = plan;
    drawHeader(p, logoImg, meta);
    drawParties(p, meta, billLines, shipLines, layout);
    drawOrderDetails(p, meta, layout);
    drawProductHeader(p, layout.phBarTop);
    let rowTop = layout.rowTop0;
    items.slice(0, rowCount).forEach((it) => { drawProductRow(p, rowTop, it); rowTop += PROD_ROW_H; });
    if (noteRow) {
      p.text('+ ' + overflow + ' more product' + (overflow === 1 ? '' : 's') + ' (see calculator)', 30, rowTop + 16, { size: 8, color: COLOR.body });
      p.line(20, rowTop + PROD_ROW_H, 592, rowTop + PROD_ROW_H, COLOR.hair, 0.5);
    }
    drawTotals(p, layout.thinRule, layout.taxesY, layout.grandY, data.tcvPdf);
    drawTerms(p, layout.termsBarTop, layout.termsSize, layout.leading, layout.paraGap, layout.lines1, layout.lines2);
    drawSignatures(p, layout.acceptBarTop);
    return p;
  }

  async function generateQuotePdf(data) {
    const p = new PdfPage();
    let logoImg = null;
    try { logoImg = await loadLogoImage(); } catch (e) { logoImg = null; }
    const plan = planQuote(p, data);
    drawQuote(p, logoImg, data, plan);
    return buildPdf(p);
  }

  // Test hook: build the page synchronously with NO logo (chrome.runtime call
  // stubbed away by the harness) and return the page + fitted layout so the tests
  // can assert overlaps / column overflows / one-page fit off the recorded boxes.
  function layoutProbe(data) {
    const p = new PdfPage();
    const plan = planQuote(p, data);
    drawQuote(p, null, data, plan);
    return { page: p, texts: p.texts, layout: plan.layout, plan: plan, PAGE_W: PAGE_W, PAGE_H: PAGE_H, BOTTOM_LIMIT: BOTTOM_LIMIT };
  }

  async function downloadQuotePdf(data) {
    const bytes = await generateQuotePdf(data);
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

  window.SQG_PDF = { downloadQuotePdf, generateQuotePdf, _layoutProbe: layoutProbe };
})();
