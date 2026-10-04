import { api, $$, DAYS } from './common.js';
import { initHeader, initReveal } from './site.js';

initHeader();
initReveal();

function weekdaysText(days) {
  const set = [...days].sort();
  if (set.join() === '1,2,3,4,5') return 'Hafta içi ziyaret';
  if (set.length === 0) return 'Ziyaret günleri duyurulacak';
  return set.map((d) => DAYS[d - 1]).join(', ') + ' günleri';
}

// Keep the visit facts in step with the panel settings; the HTML holds sensible defaults.
api('/api/config').then((cfg) => {
  $$('[data-capacity]').forEach((el) => { el.textContent = cfg.daily_capacity; });
  $$('[data-weekdays]').forEach((el) => { el.textContent = weekdaysText(cfg.weekdays); });
}).catch(() => { /* static defaults stay */ });
