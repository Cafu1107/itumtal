import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, todayTR, isISODate, addDays, isoWeekday, isTime, parseSettings, validateSettings,
  dayBlock, remainingFor, normalizePhone, isEmail, clean, validateApplication, randomCode, randomToken,
  hashPassword, verifyPassword, validatePassword, toCSV, checkTurnstile, isVisitDay, mondayOf, settingsComboErrors,
} from '../src/lib.mjs';

const S = structuredClone(DEFAULT_SETTINGS);

test('todayTR uses Istanbul time', () => {
  // 2026-10-04 22:30 UTC is already 5 October in Istanbul
  assert.equal(todayTR(Date.parse('2026-10-04T22:30:00Z')), '2026-10-05');
  assert.equal(todayTR(Date.parse('2026-10-04T20:59:00Z')), '2026-10-04');
});

test('date helpers', () => {
  assert.ok(isISODate('2026-02-28'));
  assert.ok(!isISODate('2026-02-30'));
  assert.ok(!isISODate('2026-2-3'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(isoWeekday('2026-10-04'), 7); // Sunday
  assert.equal(isoWeekday('2026-10-05'), 1); // Monday
  assert.ok(isTime('09:30') && isTime('23:59') && !isTime('9:30') && !isTime('24:00'));
});

test('dayBlock respects lead time, weekdays, closed days and season end', () => {
  const today = '2026-10-05'; // Monday
  const closed = new Map([['2026-10-29', 'Cumhuriyet Bayramı']]);
  assert.equal(dayBlock('2026-10-06', S, closed, today), 'past'); // only 1 day lead, min is 2
  assert.equal(dayBlock('2026-10-07', S, closed, today), '');
  assert.equal(dayBlock('2026-10-10', S, closed, today), 'weekday'); // Saturday
  assert.equal(dayBlock('2026-10-29', S, closed, today), 'closed');
  assert.equal(dayBlock('2027-06-01', S, closed, today), 'far');
  assert.equal(dayBlock('2026-11-02', { ...S, season_end: '2026-10-31' }, closed, today), 'season');
});

test('remainingFor never goes negative', () => {
  const used = new Map([['2026-10-07', 100], ['2026-10-08', 150]]);
  assert.equal(remainingFor('2026-10-07', S, used), 20);
  assert.equal(remainingFor('2026-10-08', S, used), 0);
  assert.equal(remainingFor('2026-10-09', S, used), 120);
});

test('settings parse + validate', () => {
  const s = parseSettings([{ key: 'daily_capacity', value: '90' }, { key: 'weekdays', value: '[2,4]' }, { key: 'junk', value: '1' }, { key: 'notice', value: '{bad' }]);
  assert.equal(s.daily_capacity, 90);
  assert.deepEqual(s.weekdays, [2, 4]);
  assert.equal(s.notice, '');
  assert.ok(!('junk' in s));

  const v = validateSettings({ daily_capacity: '150', weekdays: [5, 1, 1], booking_open: 0, season_end: '' });
  assert.ok(v.ok);
  assert.deepEqual(v.value, { daily_capacity: 150, weekdays: [1, 5], booking_open: false, season_end: '' });
  assert.ok(!validateSettings({ daily_capacity: 0 }).ok);
  assert.ok(!validateSettings({ weekdays: [8] }).ok);
  assert.ok(!validateSettings({ season_end: '2026-13-01' }).ok);
});

test('normalizePhone accepts common Turkish formats', () => {
  assert.equal(normalizePhone('0532 123 45 67'), '05321234567');
  assert.equal(normalizePhone('+90 (532) 123-45-67'), '05321234567');
  assert.equal(normalizePhone('5321234567'), '05321234567');
  assert.equal(normalizePhone('0212 261 24 20'), '02122612420');
  assert.equal(normalizePhone('00905321234567'), '05321234567');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('0132 123 45 67'), null);
});

test('email + clean', () => {
  assert.ok(isEmail('rehberlik@okul.k12.tr'));
  assert.ok(!isEmail('a@b'));
  // characters that could add recipients or headers to a mailto: link are refused
  assert.ok(!isEmail('ogretmen@okul.com?cc=evil@x.com'));
  assert.ok(!isEmail('ogretmen@okul.com&bcc=evil@x.com'));
  assert.ok(!isEmail('a,b@okul.com'));
  assert.ok(isEmail('ad.soyad+tanitim@meb.gov.tr'));
  assert.equal(clean('  Atatürk   Ortaokulu \u0000 ', 50), 'Atatürk Ortaokulu');
  assert.equal(clean('a\r\n\n\n\nb', 50, true), 'a\n\nb');
  assert.equal(clean('x'.repeat(10), 4), 'xxxx');
});

const good = {
  school_name: 'Levent Ortaokulu', district: 'Beşiktaş', teacher_name: 'Ayşe Yılmaz', teacher_role: 'Rehber öğretmen',
  phone: '0532 123 45 67', email: 'Ayse@Okul.k12.tr', student_count: 40, escort_count: '3', grade: '8. sınıf',
  time_pref: 'Sabah', preferred_dates: ['2026-10-07', '2026-10-08'], note: 'Bir öğrencimiz tekerlekli sandalye kullanıyor.', kvkk: true,
};

test('validateApplication accepts a complete form and normalises it', () => {
  const r = validateApplication(good, S);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.value.phone, '05321234567');
  assert.equal(r.value.email, 'ayse@okul.k12.tr');
  assert.equal(r.value.escort_count, 3);
});

test('validateApplication reports each bad field', () => {
  const r = validateApplication({ ...good, school_name: 'a', district: 'Mars', phone: '12', email: 'x', student_count: 0, grade: '', preferred_dates: [], kvkk: false }, S);
  assert.ok(!r.ok);
  for (const f of ['school_name', 'district', 'phone', 'email', 'student_count', 'grade', 'preferred_dates', 'kvkk']) {
    assert.ok(r.errors[f], `missing error for ${f}`);
  }
});

test('validateApplication enforces capacity and date checks', () => {
  assert.ok(validateApplication({ ...good, student_count: 121 }, S).errors.student_count);
  assert.ok(validateApplication({ ...good, preferred_dates: ['a', 'b', 'c', 'd'] }, S).errors.preferred_dates);
  const r = validateApplication(good, S, (d, n) => (d === '2026-10-08' && n > 20 ? 'dolu' : ''));
  assert.equal(r.errors.preferred_dates, 'dolu');
  // duplicates collapse
  assert.deepEqual(validateApplication({ ...good, preferred_dates: ['2026-10-07', '2026-10-07'] }, S).value.preferred_dates, ['2026-10-07']);
});

test('codes and tokens', () => {
  assert.match(randomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(randomToken(24), /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(randomToken(), randomToken());
});

test('password hashing round-trips and rejects wrong passwords', async () => {
  const h = await hashPassword('ğüşıöç-Şifre1');
  assert.match(h, /^pbkdf2\$100000\$/);
  assert.ok(await verifyPassword('ğüşıöç-Şifre1', h));
  assert.ok(!(await verifyPassword('yanlis-sifre', h)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
  assert.ok(validatePassword('kisa'));
  assert.equal(validatePassword('yeterince-uzun'), '');
});

test('toCSV escapes separators and neutralises formulas', () => {
  const csv = toCSV([{ a: 'x;y', b: '=HYPERLINK("evil")', c: 'düz' }], [
    { label: 'A', get: (r) => r.a }, { label: 'B', get: (r) => r.b }, { label: 'C', get: (r) => r.c },
  ]);
  assert.ok(csv.startsWith('﻿A;B;C\r\n'));
  assert.ok(csv.includes('"x;y"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""evil"")"`));
  assert.ok(csv.endsWith(';düz'));
});

test('checkTurnstile: off without a secret, strict with one', async () => {
  const calls = [];
  const fake = (answer) => async (url, init) => {
    calls.push({ url, secret: init.body.get('secret'), response: init.body.get('response'), ip: init.body.get('remoteip') });
    return { json: async () => answer };
  };
  assert.equal(await checkTurnstile('', undefined, '1.2.3.4', fake({ success: false })), true);
  assert.equal(await checkTurnstile('s3cret', undefined, '1.2.3.4', fake({ success: true })), 'missing');
  assert.equal(await checkTurnstile('s3cret', '', '1.2.3.4', fake({ success: true })), 'missing');
  assert.equal(calls.length, 0, 'no network call without a token');
  assert.equal(await checkTurnstile('s3cret', 'tok', '1.2.3.4', fake({ success: true })), true);
  assert.deepEqual(calls.at(-1), { url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify', secret: 's3cret', response: 'tok', ip: '1.2.3.4' });
  assert.equal(await checkTurnstile('s3cret', 'tok', 'local', fake({ success: false, 'error-codes': ['invalid-input-response'] })), 'invalid-input-response');
  assert.equal(calls.at(-1).ip, null);
  assert.equal(await checkTurnstile('s3cret', 'tok', '1.2.3.4', async () => { throw new Error('down'); }), 'unreachable');
});

test('every other Tuesday from 1 December 2026', () => {
  const s = { ...DEFAULT_SETTINGS, weekdays: [2], week_interval: 2, start_date: '2026-12-01' };
  const days = [];
  for (let d = '2026-11-01'; d <= '2027-01-31'; d = addDays(d, 1)) if (isVisitDay(d, s)) days.push(d);
  assert.deepEqual(days, ['2026-12-01', '2026-12-15', '2026-12-29', '2027-01-12', '2027-01-26']);
  assert.equal(mondayOf('2026-12-06'), '2026-11-30');
  // weekly with a start date: every Tuesday from the start
  assert.ok(isVisitDay('2026-12-08', { ...s, week_interval: 1 }));
  assert.ok(!isVisitDay('2026-11-24', { ...s, week_interval: 1 }));
  // no start date, weekly: unchanged behaviour
  assert.ok(isVisitDay('2026-10-06', { ...DEFAULT_SETTINGS }));
});

test('dayBlock reports days before the start date', () => {
  const s = { ...DEFAULT_SETTINGS, weekdays: [2], week_interval: 2, start_date: '2026-12-01' };
  assert.equal(dayBlock('2026-11-24', s, new Map(), '2026-10-06'), 'before_start');
  assert.equal(dayBlock('2026-12-08', s, new Map(), '2026-10-06'), 'weekday');
  assert.equal(dayBlock('2026-12-15', s, new Map(), '2026-10-06'), '');
});

test('rhythm settings validate', () => {
  assert.deepEqual(validateSettings({ week_interval: '2', start_date: '2026-12-01', confirm_days: 3 }).value,
    { week_interval: 2, start_date: '2026-12-01', confirm_days: 3 });
  assert.ok(validateSettings({ week_interval: 5 }).errors.week_interval);
  assert.ok(validateSettings({ start_date: '2026-13-01' }).errors.start_date);
  assert.ok(validateSettings({ confirm_days: 0 }).errors.confirm_days);
  const base = { ...DEFAULT_SETTINGS, weekdays: [2], week_interval: 2 };
  assert.ok(settingsComboErrors({ ...base, start_date: '' }).start_date);
  assert.ok(settingsComboErrors({ ...base, start_date: '2026-12-02' }).start_date);
  assert.deepEqual(settingsComboErrors({ ...base, start_date: '2026-12-01' }), {});
});
