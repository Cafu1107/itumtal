import {
  api, $, esc, icon, fmtDate, fmtDateTime, pill, toast, confirmDialog, setLoading, savedApplications, saveApplication,
  showFieldErrors,
} from './common.js';
import { initHeader } from './site.js';

initHeader();

const root = $('#track');
const token = new URLSearchParams(location.search).get('t');

function tokenFrom(text) {
  const s = String(text || '').trim();
  const m = s.match(/[?&]t=([A-Za-z0-9_-]{20,64})/) || s.match(/^([A-Za-z0-9_-]{20,64})$/);
  return m ? m[1] : null;
}

function renderPicker(message = '') {
  const saved = savedApplications();
  root.innerHTML = `
    ${message ? `<div class="callout callout--bad">${icon('alert')}<span>${esc(message)}</span></div>` : ''}
    ${saved.length ? `
      <section class="panel-card">
        <div class="panel-card__head" style="margin-bottom:16px"><div><h2>Bu cihazdaki başvurularınız</h2><p>Bu tarayıcıdan yaptığınız başvurular.</p></div></div>
        <ul class="saved-list">
          ${saved.map((s) => `<li><a href="?t=${encodeURIComponent(s.token)}">
            <span><b>${esc(s.school || 'Başvuru')}</b><small>Kod ${esc(s.code)} · ${esc(fmtDateTime(s.at))}</small></span>
            ${icon('chevron-right')}</a></li>`).join('')}
        </ul>
      </section>` : ''}
    <section class="panel-card">
      <div class="panel-card__head" style="margin-bottom:16px"><div><h2>Takip bağlantınız</h2><p>Başvurunuzu gönderdiğinizde verilen bağlantıyı buraya yapıştırın.</p></div></div>
      <form id="paste" class="linkbox" novalidate>
        <label class="visually-hidden" for="paste-input">Takip bağlantısı</label>
        <input class="input" id="paste-input" placeholder="https://…/takip.html?t=…" autocomplete="off" spellcheck="false">
        <button class="btn btn--primary" type="submit">Göster</button>
      </form>
      <p class="error-text" id="paste-error" style="margin-top:8px"></p>
      <p class="hint" style="margin-top:14px">Bağlantınızı kaybettiyseniz okulumuzu <a href="tel:+902122612420">0212 261 24 20</a> numarasından arayın; başvuru kodunuzu söylemeniz yeterli.</p>
    </section>
    <a class="btn btn--signal btn--lg" href="basvuru.html" style="justify-self:start">Yeni ziyaret başvurusu ${icon('arrow-right', 'arrow')}</a>`;
  $('#paste').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = tokenFrom($('#paste-input').value);
    if (!t) {
      $('#paste-error').innerHTML = `${icon('alert')}<span>Bu bir takip bağlantısına benzemiyor.</span>`;
      $('#paste-input').setAttribute('aria-invalid', 'true');
      return;
    }
    location.search = `?t=${encodeURIComponent(t)}`;
  });
}

const TITLES = {
  pending: 'Başvurunuz değerlendiriliyor.',
  approved: 'Ziyaretiniz onaylandı.',
  rejected: 'Başvurunuz bu kez kabul edilemedi.',
  cancelled: 'Başvuru iptal edildi.',
};

function timeline(a) {
  const steps = [{ cls: 'is-done', ic: 'check', title: 'Başvuru alındı', sub: fmtDateTime(a.created_at) }];
  if (a.status === 'pending') {
    steps.push({ cls: 'is-current', ic: 'clock', title: 'Değerlendiriliyor', sub: 'Rehberlik servisimiz sizinle iletişime geçecek.' });
    steps.push({ cls: '', ic: 'calendar', title: 'Ziyaret günü ve saati', sub: 'Görüşmenin ardından burada görünecek.' });
  } else if (a.status === 'approved') {
    steps.push({ cls: 'is-done', ic: 'check', title: 'Onaylandı', sub: '' });
    if (a.confirm_status === 'confirmed') {
      steps.push({ cls: 'is-done', ic: 'check', title: 'Katılım teyit edildi', sub: `${a.student_count} öğrenci · ${fmtDateTime(a.confirmed_at)}` });
    } else {
      steps.push({ cls: a.confirm_open ? 'is-current' : '', ic: 'users', title: 'Katılım teyidi', sub: a.confirm_open ? 'Lütfen aşağıdan teyit edin.' : `${fmtDate(a.confirm_from, { weekday: false })} tarihinde açılacak.` });
    }
    steps.push({ cls: a.confirm_status === 'confirmed' ? 'is-current' : '', ic: 'calendar', title: `Ziyaret: ${fmtDate(a.visit_date)}`, sub: `Saat ${a.visit_time}` });
  } else if (a.status === 'rejected') {
    steps.push({ cls: 'is-bad', ic: 'x', title: 'Kabul edilemedi', sub: fmtDateTime(a.updated_at) });
  } else {
    steps.push({ cls: 'is-bad', ic: 'ban', title: a.cancelled_by === 'teacher' ? 'Sizin tarafınızdan iptal edildi' : 'Okul tarafından iptal edildi', sub: fmtDateTime(a.updated_at) });
  }
  return `<ol class="timeline">${steps.map((s) => `<li class="${s.cls}"><span class="dot">${icon(s.ic)}</span><div><b>${esc(s.title)}</b><span>${esc(s.sub)}</span></div></li>`).join('')}</ol>`;
}

function render(a) {
  const msg = a.message ? `<div class="message-box"><small>Okulun notu</small>${esc(a.message)}</div>` : '';
  let lead = '';
  if (a.status === 'pending') lead = `<p class="hint" style="font-size:1rem">Tercih ettiğiniz ${a.preferred_dates.length > 1 ? 'günler' : 'gün'}: <b>${a.preferred_dates.map((d) => esc(fmtDate(d, { weekday: false }))).join(', ')}</b>. Rehberlik servisimiz gün ve saati netleştirmek için sizi arayacak.</p>`;
  if (a.status === 'approved') {
    lead = `<div class="visit-when">
      <div>${icon('calendar')}${esc(fmtDate(a.visit_date, { year: true }))}</div>
      <div>${icon('clock')}${esc(a.visit_time)}</div>
    </div>`;
  }
  let confirm = '';
  if (a.status === 'approved' && a.confirm_status === 'confirmed') {
    confirm = `<div class="confirm confirm--done">${icon('check')}<div><b>Katılımınız teyit edildi.</b><span>${a.student_count} öğrenciyle bekliyoruz. Değişiklik olursa lütfen okulu arayın.</span></div></div>`;
  } else if (a.status === 'approved' && a.confirm_open) {
    confirm = `
      <form class="confirm confirm--ask" id="confirm-form" novalidate>
        <div class="confirm__head">${icon('users')}<div><b>Katılımınızı teyit edin</b><span>Ziyaret yaklaştı. Geleceğinizi ve kesin öğrenci sayısını bildirir misiniz?</span></div></div>
        <div class="confirm__row">
          <div class="field">
            <label class="label" for="confirm-count">Gelecek öğrenci sayısı</label>
            <input class="input" id="confirm-count" name="student_count" type="number" inputmode="numeric" min="1" max="${a.student_count}" value="${a.student_count}">
          </div>
          <button class="btn btn--ok btn--lg" type="submit">${icon('check')}Geleceğiz, teyit et</button>
        </div>
        <p class="error-text" data-error-for="student_count"></p>
        <p class="hint">Gelemeyecekseniz aşağıdaki "Başvuruyu iptal et" düğmesini kullanın; yeriniz başka okullara açılır.</p>
      </form>`;
  } else if (a.status === 'approved' && a.visit_date >= new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)) {
    confirm = `<p class="hint" style="font-size:.9375rem">${icon('info', 'inline-icon')} Ziyaretinizden birkaç gün önce, <b>${esc(fmtDate(a.confirm_from, { weekday: false }))}</b> tarihinden itibaren bu sayfadan katılımınızı teyit etmeniz istenecek.</p>`;
  }
  root.innerHTML = `
    <article class="status-card status-card--${a.status}">
      <div class="status-card__hero">
        <div>${pill(a.status)}</div>
        <h2 class="display" style="font-size:clamp(1.75rem,1.2rem + 2vw,2.5rem)">${TITLES[a.status]}</h2>
        ${lead}
        ${msg}
        ${confirm}
      </div>
      ${timeline(a)}
      <dl class="details">
        <div><dt>Başvuru kodu</dt><dd class="num">${esc(a.code)}</dd></div>
        <div><dt>Okul</dt><dd>${esc(a.school_name)}</dd></div>
        <div><dt>Başvuran</dt><dd>${esc(a.teacher_name)}</dd></div>
        <div><dt>Öğrenci sayısı</dt><dd class="num">${a.student_count}</dd></div>
        <div><dt>Tercih edilen günler</dt><dd>${a.preferred_dates.map((d) => esc(fmtDate(d, { weekday: false }))).join(', ')}</dd></div>
        <div><dt>Saat tercihi</dt><dd>${esc(a.time_pref)}</dd></div>
      </dl>
      <div class="status-card__actions">
        ${a.status === 'approved' ? `<button class="btn btn--primary" type="button" id="ics">${icon('download')}Takvime ekle</button>
          <a class="btn" href="https://www.google.com/maps/dir/?api=1&amp;destination=41.088568,29.026529" target="_blank" rel="noopener">${icon('navigation')}Yol tarifi</a>` : ''}
        <button class="btn" type="button" id="reload">${icon('refresh')}Yenile</button>
        ${a.can_cancel ? `<button class="btn btn--danger" type="button" id="cancel" style="margin-left:auto">${icon('ban')}Başvuruyu iptal et</button>` : ''}
      </div>
    </article>
    <p class="hint">Sorunuz mu var? Okulumuzu <a href="tel:+902122612420">0212 261 24 20</a> numarasından arayabilirsiniz.</p>`;

  $('#reload').addEventListener('click', load);
  $('#confirm-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const n = Number(form.student_count.value);
    if (!Number.isInteger(n) || n < 1) { showFieldErrors(form, { student_count: 'Gelecek öğrenci sayısını yazın.' })?.focus(); return; }
    if (n > a.student_count) { showFieldErrors(form, { student_count: `Onaylanan sayı ${a.student_count}. Daha kalabalık gelecekseniz lütfen okulu arayın.` })?.focus(); return; }
    const btn = form.querySelector('[type=submit]');
    setLoading(btn, true);
    try {
      const res = await api(`/api/track/${encodeURIComponent(token)}/confirm`, { method: 'POST', body: { student_count: n } });
      toast('Katılımınız teyit edildi. Teşekkürler!');
      render(res);
    } catch (err) {
      setLoading(btn, false);
      showFieldErrors(form, err.data?.fields || {});
      toast(err.message, { type: 'bad' });
    }
  });
  $('#ics')?.addEventListener('click', () => downloadICS(a));
  $('#cancel')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Başvuru iptal edilsin mi?',
      text: a.status === 'approved' ? `${fmtDate(a.visit_date)} ${a.visit_time} ziyaretiniz iptal edilecek ve yeriniz başka okullara açılacak.` : 'Başvurunuz geri çekilecek.',
      ok: 'İptal et', cancel: 'Vazgeç', danger: true,
    });
    if (!ok) return;
    setLoading(e.target, true);
    try {
      await api(`/api/track/${encodeURIComponent(token)}/cancel`, { method: 'POST' });
      toast('Başvurunuz iptal edildi.');
      load();
    } catch (err) {
      setLoading(e.target, false);
      toast(err.message, { type: 'bad' });
    }
  });
}

function downloadICS(a) {
  const [h, m] = a.visit_time.split(':').map(Number);
  const start = `${a.visit_date.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
  const end = `${a.visit_date.replace(/-/g, '')}T${String(Math.min(h + 2, 23)).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
  const esc = (s) => String(s).replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ITU MTAL//Ziyaret//TR', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${a.code}@itumtal-ziyaret`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;TZID=Europe/Istanbul:${start}`,
    `DTEND;TZID=Europe/Istanbul:${end}`,
    `SUMMARY:${esc('İTÜ MTAL okul tanıtım ziyareti')}`,
    `LOCATION:${esc('İTÜ Mesleki ve Teknik Anadolu Lisesi, Akat Mah. Zeytinoğlu Cad. No:80, Etiler, Beşiktaş/İstanbul')}`,
    `DESCRIPTION:${esc(`${a.school_name} · ${a.student_count} öğrenci · Başvuru kodu ${a.code}${a.message ? `\n${a.message}` : ''}`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `itumtal-ziyaret-${a.visit_date}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function load() {
  try {
    const a = await api(`/api/track/${encodeURIComponent(token)}`);
    saveApplication({ token, code: a.code, school: a.school_name, at: a.created_at });
    render(a);
  } catch (err) {
    renderPicker(err.status === 404 ? 'Bu bağlantıyla bir başvuru bulunamadı. Bağlantıyı eksiksiz kopyaladığınızdan emin olun.' : err.message);
  }
}

if (token) load();
else renderPicker();
