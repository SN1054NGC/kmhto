'use strict';
// Тест модуля ФГИС «Аршин»: построение запроса, мягкий поиск, нормализация,
// поведение при ошибках, повтор по наименованию, кэш.
process.env.KMHTO_ARSHIN_INTERVAL_MS = '0';   // без паузы в тестах

const arshin = require('../server/arshin.js');

let fails = 0, passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  OK   ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' [' + extra + ']' : '')); }
}

console.log('=== Построение запроса ===');
ok('мягкий поиск: *текст* и пробелы -> ?', arshin.soft('иванов насос') === '*иванов?насос*', arshin.soft('иванов насос'));
const q = arshin.buildQuery({ number: '00534418', rows: 5, sort: 'verification_date+desc' });
ok('номер уходит в mi_number', q.indexOf('mi_number=*00534418*') !== -1, q);
ok('sort не кодируется (нужен +, а не %2B)', q.indexOf('sort=verification_date+desc') !== -1, q);
ok('rows ограничен 100', arshin.buildQuery({ rows: 500 }).indexOf('rows=100') !== -1);
ok('начало выборки всегда есть', q.indexOf('start=0') !== -1);

console.log('=== Нормализация ответа ===');
const norm = arshin.normalizeItem({
  vri_id: '1-123', org_title: 'ФБУ ЦСМ', mit_number: '44424-12', mit_title: 'Расходомеры',
  mit_notation: 'КАРАТ-520', mi_modification: '80-0', mi_number: '00534418',
  verification_date: '2026-09-16', valid_date: '2030-09-15', result_docnum: 'С-АЭ/123', applicability: true
});
ok('поля переименованы', norm.id === '1-123' && norm.title === 'Расходомеры' && norm.number === '00534418');
ok('ссылка ведёт на запись по идентификатору (eapi, вне SPA)', /\/eapi\/vri\/1-123$/.test(norm.url), norm.url);
ok('есть ссылка на страницу поиска Аршина', /\/cm\/results$/.test(norm.searchUrl), norm.searchUrl);
ok('пригодность распознана', norm.applicable === true);

console.log('=== Запросы к API (fetch подменён) ===');
const calls = [];
let mode = 'number-hit';
global.fetch = async function (url) {
  calls.push(String(url));
  if (mode === 'http500') return { ok: false, status: 500, text: async function () { return 'oops'; } };
  if (mode === 'notjson') return { ok: true, status: 200, text: async function () { return '<html>blocked</html>'; } };
  if (mode === 'status') return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'error', message: 'слишком часто' }); } };
  const isNumber = String(url).indexOf('mi_number=') !== -1;
  if (mode === 'number-hit' || (mode === 'number-miss' && !isNumber)) {
    return { ok: true, status: 200, text: async function () {
      return JSON.stringify({ result: { count: isNumber ? 1 : 7, start: 0, rows: 20, items: [{
        vri_id: isNumber ? '1-A' : '1-B', org_title: 'ЦСМ', mit_number: '1-2', mit_title: 'Тип',
        mit_notation: 'Т', mi_modification: 'М', mi_number: '00534418',
        verification_date: '2026-01-01', valid_date: '2027-01-01', result_docnum: 'СВ-1', applicability: true
      }] } });
    } };
  }
  return { ok: true, status: 200, text: async function () { return JSON.stringify({ result: { count: 0, start: 0, rows: 20, items: [] } }); } };
};

(async function () {
  mode = 'number-hit';
  const r1 = await arshin.search({ number: '00534418', name: 'Расходомеры' });
  ok('найден по номеру, второй запрос не понадобился', r1.items.length === 1 && calls.length === 1, 'запросов ' + calls.length);
  ok('в ответе есть счётчик и признак кэша', typeof r1.count === 'number' && r1.cached === false);

  const r1b = await arshin.search({ number: '00534418', name: 'Расходомеры' });
  ok('повторный запрос берётся из кэша', r1b.cached === true && calls.length === 1, 'запросов ' + calls.length);

  ok('режим «точный» отдан клиенту', r1.mode === 'exact', r1.mode);
  ok('ссылка ведёт на запись по идентификатору, без «похожих»', /\/eapi\/vri\/1-A$/.test(r1.items[0].url), r1.items[0].url);

  calls.length = 0;
  mode = 'number-miss';
  const r2 = await arshin.search({ number: 'ZZZ', name: 'Насос' });
  ok('точный -> нечёткий -> по названию', calls.length === 3 && r2.items.length === 1, 'запросов ' + calls.length);
  ok('точный запрос без звёздочек', calls[0].indexOf('*') === -1, calls[0].slice(0, 84));
  ok('нечёткий запрос со звёздочками', calls[1].indexOf('*ZZZ*') !== -1, calls[1].slice(0, 84));
  ok('третий запрос — по названию (mit_title)', calls[2].indexOf('mit_title=') !== -1, calls[2].slice(0, 90));
  ok('режим поиска отдан клиенту', r2.mode === 'name', r2.mode);

  console.log('=== Гибкие фильтры (рег. №, свидетельство, обозначение, организация, год) ===');
  calls.length = 0;
  mode = 'number-miss';
  const r3 = await arshin.search({ docnum: 'СВ-1', name: 'Насос', org: 'ЦСМ', year: '2026' });
  ok('несколько условий: сначала комбинированный запрос',
     calls.length === 1 && calls[0].indexOf('result_docnum=') !== -1, calls[0].slice(0, 120));
  ok('в комбинированный запрос попали организация и год',
     calls[0].indexOf('org_title=') !== -1 && calls[0].indexOf('year=2026') !== -1, calls[0].slice(0, 170));
  ok('режим combined отдан клиенту', r3.mode === 'combined', r3.mode);

  calls.length = 0;
  const r4 = await arshin.search({ docnum: 'СВ-1' });
  ok('поиск только по свидетельству -> result_docnum',
     calls.length === 1 && calls[0].indexOf('result_docnum=') !== -1, calls[0].slice(0, 120));
  ok('режим docnum отдан клиенту', r4.mode === 'docnum', r4.mode);

  calls.length = 0;
  const r5 = await arshin.search({ notation: 'КАРАТ' });
  ok('обозначение -> mit_notation', calls.length === 1 && calls[0].indexOf('mit_notation=') !== -1, calls[0].slice(0, 120));
  ok('режим notation отдан клиенту', r5.mode === 'notation', r5.mode);

  calls.length = 0;
  const r6 = await arshin.search({ org: 'ЦСМ' });
  ok('организация -> org_title', calls.length === 1 && calls[0].indexOf('org_title=') !== -1, calls[0].slice(0, 120));
  ok('режим org отдан клиенту', r6.mode === 'org', r6.mode);

  const qq = arshin.buildQuery({ notation: 'КАРАТ', org: 'ЦСМ', docnum: 'СВ', year: '2026', sort: 'valid_date+desc' });
  ok('buildQuery: новые поля и год',
     qq.indexOf('mit_notation=') !== -1 && qq.indexOf('org_title=') !== -1 && qq.indexOf('year=2026') !== -1, qq);
  ok('buildQuery: сортировка по сроку действия не кодируется', qq.indexOf('sort=valid_date+desc') !== -1, qq);

  try { await arshin.search({ year: '2026' }); ok('только год без других условий отклонён', false); }
  catch (e) { ok('только год без других условий отклонён', /укажите/.test(e.message), e.message); }

  mode = 'http500';
  try { await arshin.search({ number: 'X1' }); ok('ошибка HTTP проброшена', false); }
  catch (e) { ok('ошибка HTTP проброшена', /500/.test(e.message), e.message); }

  mode = 'notjson';
  try { await arshin.search({ number: 'X2' }); ok('не-JSON распознан', false); }
  catch (e) { ok('не-JSON распознан (VPN/зарубежный IP)', /JSON/.test(e.message), e.message); }

  mode = 'status';
  try { await arshin.search({ number: 'X3' }); ok('сообщение ФГИС проброшено', false); }
  catch (e) { ok('сообщение ФГИС проброшено', /часто/.test(e.message), e.message); }

  try { await arshin.search({}); ok('пустой запрос отклонён', false); }
  catch (e) { ok('пустой запрос отклонён', /укажите/.test(e.message), e.message); }

  console.log('=== Карточка записи ===');
  global.fetch = async function (url) {
    return { ok: true, status: 200, text: async function () {
      return JSON.stringify({ result: {
        miInfo: { singleMI: { mitypeURL: 'https://fgis.gost.ru/fundmetrology/cm/mits/abc', mitypeTitle: 'Тип СИ',
                              mitypeType: 'КАРАТ', mitypeNumber: '44424-12', manufactureNum: '00534418', modification: '80-0' } },
        vriInfo: { organization: 'ФБУ ЦСМ', vrfDate: '16.09.2026', validDate: '15.09.2030', docTitle: 'МП 22',
                   vriType: 'Периодическая', signCipher: 'АБВ', miOwner: 'ООО Ромашка',
                   applicable: { certNum: 'С-АЭ/123' } },
        nonpub: { verifiername: 'Иванов И.И.', calibration: true, conditions: { temperature: '22', pressure: '101' } },
        means: {
          mieta: [{ regNumber: '3.1.АБВ-1', mietaURL: 'https://fgis.gost.ru/fundmetrology/cm/mieta/eta1',
                    mitypeNumber: '11111-11', mitypeURL: 'https://fgis.gost.ru/fundmetrology/cm/mits/eta',
                    mitypeTitle: 'Эталон-тип', notation: 'ЭТ', modification: 'М1', manufactureNum: 'э-77',
                    manufactureYear: '2019', rankCode: '1', rankTitle: '1-й разряд', schemaTitle: 'ГПС' }],
          mis: [{ mitypeNumber: '22222-22', mitypeURL: 'https://fgis.gost.ru/fundmetrology/cm/mits/mi',
                  mitypeTitle: 'Вспомогательное СИ', number: 'в-5' }]
        },
        info: { additional_info: 'Доп. сведения' }
      } });
    } };
  };
  const rec = await arshin.record('1-123');
  ok('карточка: № свидетельства', rec.certificate === 'С-АЭ/123', rec.certificate);
  ok('карточка: ссылка на тип СИ', /\/mits\/abc/.test(rec.typeUrl), rec.typeUrl);
  ok('карточка: поверитель', rec.verifier === 'Иванов И.И.', rec.verifier);
  ok('карточка: даты', rec.verificationDate === '16.09.2026' && rec.validDate === '15.09.2030');
  ok('карточка: вид поверки и владелец', rec.vriType === 'Периодическая' && rec.owner === 'ООО Ромашка');
  ok('карточка: условия поверки', rec.conditions && rec.conditions.temperature === '22');
  ok('карточка: калибровка распознана', rec.calibration === true);
  ok('карточка: ссылка открывается вне SPA', /\/eapi\/vri\/1-123$/.test(rec.url), rec.url);
  ok('карточка: рег. № типа СИ', rec.typeNumber === '44424-12' && rec.notation === 'КАРАТ');
  // эталоны со ссылками на карточки типов
  ok('эталоны: один эталон разобран', rec.etalons.length === 1);
  const et = rec.etalons[0] || {};
  ok('эталон: номер и разряд', et.regNumber === '3.1.АБВ-1' && et.rankTitle === '1-й разряд', et.rankTitle);
  ok('эталон: ссылка на тип', /\/mits\/eta$/.test(et.typeUrl), et.typeUrl);
  ok('эталон: ссылка на эталон', /\/mieta\/eta1$/.test(et.regUrl), et.regUrl);
  ok('эталон: зав. № и год', et.number === 'э-77' && et.year === '2019');
  ok('применённые СИ: разобраны', rec.applied.length === 1 && rec.applied[0].number === 'в-5');
  ok('доп. сведения сохранены', rec.additionalInfo === 'Доп. сведения');
  ok('карточка помечена временем проверки', typeof rec.checkedAt === 'string' && rec.checkedAt.length >= 10);
  try { await arshin.record(''); ok('карточка без id отклонена', false); }
  catch (e) { ok('карточка без id отклонена', /идентификатор/.test(e.message), e.message); }

  // Живая проверка (не влияет на результат теста)
  if (process.env.KMHTO_ARSHIN_LIVE === '1') {
    delete global.fetch;
    try {
      const live = await arshin.search({ number: '00534418', rows: 2 });
      console.log('  ЖИВОЙ ЗАПРОС: найдено ' + live.items.length + ' из ' + live.count);
    } catch (e) { console.log('  ЖИВОЙ ЗАПРОС не удался: ' + e.message); }
  }

  console.log('');
  console.log(fails === 0 ? ('!!! ФГИС АРШИН: ВСЕ ' + passed + ' ПРОВЕРОК ПРОЙДЕНЫ !!!') : ('!!! ПРОВАЛОВ: ' + fails + ' !!!'));
  process.exit(fails === 0 ? 0 : 1);
})();
