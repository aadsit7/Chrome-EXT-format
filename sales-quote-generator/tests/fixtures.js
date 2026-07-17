'use strict';

/* Text/DOM fixtures modeled on the two REAL Salesforce Opportunity pages the
   user attached (source of truth for field labels + value formats):

     • NEW BUSINESS — Opportunity "Insight - AW MSP"
       (…/lightning/r/Opportunity/006UJ00000cw1STYAY/view)
       Quote Information + a Products related list; Account "Product(s)" is a
       semicolon list; Endpoint Tier is a range (context only); term lives in the
       grid's Subscription Term column.

     • RENEWAL — Opportunity "Gulfstream Aerospace Corp. 2026-09-30"
       (…/lightning/r/Opportunity/006UJ00000VcOXMYA3/view)
       Renewals (Critical Renewal Information) + Subscription Information panels,
       a Partner/Reseller (Insight) and Subscription Type "Reseller"; the product
       comes from the "Product(s)" field, quantity from the panel, current price
       from "ARR up for Renewal". Includes noise sections (System Information,
       Stage History, Opportunity Field History) to prove they're excluded.

   The HTML mirrors Salesforce Lightning markup closely enough that the real
   in-page extractor (extractQuoteInfo) and snapshot (snapshotPage) run against
   it unchanged. */

function field(label, value) {
  return '<div class="slds-form-element">' +
    '<span class="slds-form-element__label">' + label + '</span>' +
    '<div class="slds-form-element__control">' +
    '<lightning-formatted-text class="slds-form-element__static">' + (value == null ? '' : value) + '</lightning-formatted-text>' +
    '</div></div>';
}

function card(title, innerHTML) {
  return '<article class="slds-card">' +
    '<h3 class="slds-card__header-title">' + title + '</h3>' +
    '<div class="slds-card__body">' + innerHTML + '</div></article>';
}

/* rows: array of arrays; a cell may be { link: 'Full Name', text: 'Trunc…' } to
   model Salesforce truncation (full value in the anchor title), or a plain
   string, or { checkbox: true/false } for the Contact Roles "Primary" column. */
function grid(headers, rows) {
  var thead = '<thead><tr>' + headers.map(function (h) {
    return '<th title="' + h + '">' + h + '</th>';
  }).join('') + '</tr></thead>';
  var tbody = '<tbody>' + rows.map(function (r) {
    return '<tr>' + r.map(function (c) {
      if (c && typeof c === 'object' && 'checkbox' in c) {
        return '<td><input type="checkbox"' + (c.checkbox ? ' checked' : '') + '></td>';
      }
      if (c && typeof c === 'object' && 'link' in c) {
        return '<td><a title="' + c.link + '" href="#">' + (c.text || c.link) + '</a></td>';
      }
      return '<td>' + (c == null ? '' : c) + '</td>';
    }).join('') + '</tr>';
  }).join('') + '</tbody>';
  return '<table role="grid">' + thead + tbody + '</table>';
}

/* ---------------- NEW BUSINESS (Insight - AW MSP) ---------------- */

var NEW_BUSINESS_HTML =
  card('Highlights',
    field('Account Name', 'Insight') +
    field('Close Date', '11/25/2026') +
    field('Amount Prior to NUE CPQ', 'USD 94,410.00') +
    field('Opportunity Owner', 'Aaron Adsit')
  ) +
  card('Quote Information',
    field('Primary Quote', 'Insight Quote - Placeholder') +
    field('Quote Expiration Date', '') +
    field('Expiration Date', '4/23/2026') +
    field('Amended Terms', '') +
    field('Purchase Order #', '') +
    field('Total Price', 'USD 104,410.00') +
    field('Volume Discount', 'USD 125,880.00') +
    field('Real Discount %', '23.16%') +
    field('Real Discount Amount', 'USD 21,470.00') +
    field('Total Real List', 'USD 110,400.00') +
    field('Discount From List', 'USD 5,990.00')
  ) +
  card('Products',
    grid(['Product', 'Product Code', 'Opp Product Name', 'Amount', 'Quantity', 'Subscription Term', 'Discount', 'Revenue Type'], [
      [{ link: 'Application Workspace', text: 'Application Wo…' }, 'AWCLD', '', 'USD 94,410.00', '10,000.00', '12.000000000000', '', 'Cross-sell'],
      [{ link: 'AW Standard Onboarding', text: 'AW Standard O…' }, 'OB-AW-STAND', '', '0.00', '1.00', '', '', 'Cross-sell'],
    ])
  ) +
  card('Contact Roles',
    grid(['Contact Name', 'Role', 'Primary', 'Phone', 'Email', 'OCR Created Date'], [
      [{ link: 'Adam Duffy' }, '', { checkbox: true }, '+1 952-674-2963', 'adam.duffy@insight.com', '10/24/2025, 12:04'],
    ])
  ) +
  card('Account Details',
    field('Account Name', 'Insight') +
    field('Phone', '509-742-2207') +
    field('Industry', 'Technology') +
    field('Product(s)', 'Application Manager Enterprise;Endpoint Insights Subscription;Insights;Patching;Right Click Tools Subscription;Right Click Tools Subscription - Legacy') +
    field('Website', 'insight.com') +
    field('Support Plan', 'Standard') +
    field('Endpoint Tier', '1,001 - 5,000') +
    field('Version (RMS)', '') +
    field('Current Device Count', '')
  );

var NEW_BUSINESS_URL = 'https://recastsoftware.lightning.force.com/lightning/r/Opportunity/006UJ00000cw1STYAY/view';

/* What the upgraded Apps Script would return for this page (Task 4 schema). */
var NEW_BUSINESS_AI = {
  isRenewal: false,
  customer: 'Insight',
  contactName: 'Adam Duffy',
  email: 'adam.duffy@insight.com',
  quoteExpirationDate: '2026-04-23',
  currency: 'USD',
  termMonths: 12,
  lines: [{ product: 'Application Workspace', qty: 10000 }],
};

/* ---------------- RENEWAL (Gulfstream Aerospace Corp.) ---------------- */

var RENEWAL_HTML =
  card('Highlights',
    field('Account Name', 'Gulfstream Aerospace Corp.') +
    field('Close Date', '9/29/2026') +
    field('Amount Prior to NUE CPQ', 'USD 69,817.71') +
    field('Opportunity Owner', 'Lauren Chadare')
  ) +
  card('Opportunity Information',
    field('Opportunity Name', 'Gulfstream Aerospace Corp. 2026-09-30') +
    field('Opportunity Record Type', 'Renewal') +
    field('Close Date', '9/29/2026') +
    field('Opportunity Currency', 'USD - U.S. Dollar') +
    field('Account Name', 'Gulfstream Aerospace Corp.') +
    field('Stage', 'Renewal In Process') +
    field('Price Book', 'Nue Direct') +
    field('Partner/Reseller', 'Insight') +
    field('Amount', 'USD 5,818.14') +
    field('Primary Contact', 'Travis Xiong') +
    field('Maximum Device Count New', '20,000.00')
  ) +
  card('Renewals',
    field('License Start Date', '9/30/2026') +
    field('License Expiration Date', '9/29/2027') +
    field('Subscription Term', '12.000000000000') +
    field('Quantity', '20,000') +
    field('ARR up for Renewal', 'USD 133,000.00') +
    field('Renewal ARR', 'USD 69,817.71') +
    field('Renewal Month Date', '9/30/2026') +
    field('Subscription Type', 'Reseller') +
    field('Product(s)', 'Right Click Tools') +
    field('TCV up for Renewal', 'USD 133,000.00') +
    field('MRR', 'USD 5,818.14')
  ) +
  card('Subscription Information',
    field('Start Date', '9/30/2026') +
    field('End Date', '9/29/2027') +
    field('Billing Frequency', 'Annually') +
    field('Subscription Type', 'Reseller') +
    field('Subscription Term', '12.000000000000') +
    field('License Start Date', '9/30/2026') +
    field('Renewal Month Date', '9/30/2026') +
    field('Quantity', '20,000') +
    field('Product(s)', 'Right Click Tools') +
    field('Contract', '00010608') +
    field('License Expiration Date', '9/29/2027')
  ) +
  card('Contact Roles',
    grid(['Contact Name', 'Role', 'Primary', 'Phone', 'Email', 'OCR Created Date'], [
      [{ link: 'Travis Xiong' }, 'Portal User', { checkbox: true }, '+1 912-677-9434', 'travis.xiong@gulfstream.com', '7/28/2025, 11:32'],
      [{ link: 'Jason Brannen' }, 'Portal User', { checkbox: false }, '(912) 667-5919', 'jason.brannen@gulfstream.com', '7/28/2025, 11:32'],
      [{ link: 'Rusty Pass' }, 'Evaluator', { checkbox: false }, '(912) 251-5774', 'rusty.pass@gulfstream.com', '7/28/2025, 11:32'],
    ])
  ) +
  card('Account Details',
    field('Account Name', 'Gulfstream Aerospace Corp.') +
    field('Phone', '(912) 433-3764') +
    field('Industry', 'Manufacturing/Distribution') +
    field('Product(s)', 'Application Workspace - Cloud;Endpoint Insights Subscription;Privilege Manager;Right Click Tools Subscription;Support Subscription') +
    field('Website', 'www.gulfstream.com') +
    field('Support Plan', 'Premium') +
    field('Endpoint Tier', '10,001 - 50,000') +
    field('Current Device Count', '20,000')
  ) +
  /* ---- noise sections that MUST be excluded from the AI snapshot ---- */
  card('System Information',
    field('Created By', 'NUE Integration User, 7/28/2025, 11:01 PM') +
    field('Last Modified By', 'Lauren Chadare, 7/8/2026, 7:47 AM')
  ) +
  card('Opportunity Field History',
    grid(['Date', 'Field', 'User', 'Original Value', 'New Value'], [
      ['7/8/2026, 7:47 AM', 'Next Step', 'Lauren Chadare', '7/6: Built quote for RCT', '7/8: Built quote for MSRP'],
      ['7/6/2026, 12:03 PM', 'Quantity', 'Lauren Chadare', '', '20,000'],
    ])
  ) +
  card('Stage History',
    grid(['Stage', 'Amount', 'Probability (%)', 'Expected Revenue', 'Close Date', 'Last Modified By', 'Last Modified'], [
      ['Renewal In Process', 'USD 5,818.14', '94%', 'USD 5,469.05', '9/29/2026', 'Lauren Chadare', '7/8/2026, 7:42 AM'],
    ])
  );

var RENEWAL_URL = 'https://recastsoftware.lightning.force.com/lightning/r/Opportunity/006UJ00000VcOXMYA3/view';

/* What the upgraded Apps Script would return for this page (Task 4 schema). */
var RENEWAL_AI = {
  isRenewal: true,
  customer: 'Gulfstream Aerospace Corp.',
  partnerCompany: 'Insight',
  contactName: 'Travis Xiong',
  email: 'travis.xiong@gulfstream.com',
  renewalDate: '2027-09-29',
  currency: 'USD',
  termMonths: 12,
  renewLines: [{ product: 'Right Click Tools', qty: 20000, currentAnnualPrice: 133000 }],
};

module.exports = {
  NEW_BUSINESS_HTML: NEW_BUSINESS_HTML, NEW_BUSINESS_URL: NEW_BUSINESS_URL, NEW_BUSINESS_AI: NEW_BUSINESS_AI,
  RENEWAL_HTML: RENEWAL_HTML, RENEWAL_URL: RENEWAL_URL, RENEWAL_AI: RENEWAL_AI,
};
