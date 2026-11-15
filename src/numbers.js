'use strict';

/*
 * Turns digits in Hebrew text into Hebrew words before the text is sent to a voice, because
 * some voices silently skip digits ("השעה 8 בערב" came out as "השעה בערב").
 * Numbers use the feminine counting form, the way Israelis read numbers and clock times.
 * Text without digits is returned unchanged.
 */

const ONES = ['אפס', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע'];
const TEENS = ['עשר', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה',
  'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה'];
const TENS = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
const HUNDREDS = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות',
  'שבע מאות', 'שמונה מאות', 'תשע מאות'];
const THOUSANDS = ['', 'אלף', 'אלפיים', 'שלושת אלפים', 'ארבעת אלפים', 'חמשת אלפים', 'ששת אלפים',
  'שבעת אלפים', 'שמונת אלפים', 'תשעת אלפים', 'עשרת אלפים'];

/** Join parts the Hebrew way: "a b וc" — "ו" only before the last part. */
function join(parts) {
  const p = parts.filter(Boolean);
  if (p.length < 2) return p[0] || '';
  return `${p.slice(0, -1).join(' ')} ו${p[p.length - 1]}`;
}

function below100(n) {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t} ו${ONES[n % 10]}` : t;
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!r) return HUNDREDS[h];
  if (!h) return below100(r);
  // "מאה עשרים ושלוש" / "מאה ושלוש"
  return r < 20 || r % 10 === 0 ? `${HUNDREDS[h]} ו${below100(r)}` : `${HUNDREDS[h]} ${below100(r)}`;
}

/** 0–999,999 in words; larger numbers are read digit by digit. */
function numberToWords(n) {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n < 1000) return below1000(n);
  if (n >= 1000000) return digitByDigit(String(n));
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  const thWords = th <= 10 ? THOUSANDS[th] : `${below1000(th)} אלף`;
  if (!r) return thWords;
  return r < 100 || r % 100 === 0 ? `${thWords} ו${below1000(r)}` : `${thWords} ${below1000(r)}`;
}

function digitByDigit(s) {
  return s.split('').map((d) => ONES[Number(d)]).join(' ');
}

/** "20:00" → "שמונה בערב", "7:30" → "שבע וחצי בבוקר". */
function timeToWords(h, m, periodFollows) {
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  let words = below100(hour12);
  if (m === 15) words += ' ורבע';
  else if (m === 30) words += ' וחצי';
  else if (m > 0) words += ` ו${below100(m)}`;
  if (periodFollows) return words;
  let period;
  if (h >= 5 && h < 12) period = 'בבוקר';
  else if (h >= 12 && h < 14) period = 'בצהריים';
  else if (h >= 14 && h < 18) period = 'אחר הצהריים';
  else if (h >= 18 && h < 22) period = 'בערב';
  else period = 'בלילה';
  return `${words} ${period}`;
}

const PERIOD_AFTER = /^\s*(בבוקר|בצהריים|בצהרים|אחר הצהריים|אחרי הצהריים|בערב|בלילה)/;

function hebrewNumbers(text) {
  let s = String(text);
  if (!/\d/.test(s)) return s;

  // clock times: 20:00, 7:30
  s = s.replace(/(\d{1,2}):(\d{2})(?!\d)/g, (all, hh, mm, offset, whole) => {
    const h = Number(hh);
    const m = Number(mm);
    if (h > 23 || m > 59) return all;
    const after = whole.slice(offset + all.length);
    return timeToWords(h, m, PERIOD_AFTER.test(after));
  });

  // a Hebrew prefix letter joined with a hyphen: "ב-8" → "ב8" (it becomes "בשמונה")
  s = s.replace(/(^|[\s(])([בלמהוכש])[-־](?=\d)/g, '$1$2');

  // numbers with thousands separators, decimals, percent and degrees
  s = s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (num) => {
    const plain = num.replace(/,/g, '');
    const [int, frac] = plain.split('.');
    let words = int.length > 1 && int.startsWith('0') ? digitByDigit(int) : numberToWords(Number(int));
    if (int.length > 7) words = digitByDigit(int); // phone numbers and codes
    if (frac) words += ` נקודה ${frac.length <= 2 && !frac.startsWith('0') ? numberToWords(Number(frac)) : digitByDigit(frac)}`;
    return words;
  });

  // symbols that usually follow a number
  s = s.replace(/\s*%/g, ' אחוז').replace(/\s*°\s*C?/g, ' מעלות');
  return s;
}

module.exports = { hebrewNumbers, numberToWords };
