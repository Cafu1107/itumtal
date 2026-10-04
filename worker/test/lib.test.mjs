import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, todayTR, isISODate, addDays, isoWeekday, isTime, parseSettings, validateSettings,
  dayBlock, remainingFor, normalizePhone, isEmail, clean, validateApplication, randomCode, randomToken,
  hashPassword, verifyPassword, validatePassword, toCSV,
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
