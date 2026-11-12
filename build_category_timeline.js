/*
 * 품목(cat2)이 랭킹에서 언제부터 늘고 언제부터 줄었는지를 주 단위로 추적한다.
 *
 * "후드집업이 줄기 시작했다"를 말하려면 지금 비중만으로는 안 되고 시간축이 있어야 한다.
 * 주마다 그 품목이 랭킹에 몇 개 올라왔는지를 이어 붙이고, 꺾인 지점을 찾는다.
 *
 * 꼭 알아야 할 한계 두 가지 - 화면에도 같은 말을 적어둔다.
 *  1) 이건 판매량이 아니라 "랭킹에 올라온 상품 수"다. 무신사 랭킹이 판매 기반이긴 해도
 *     한 품목이 150칸을 몇 개 차지했는지일 뿐, 몇 장 팔렸는지가 아니다.
 *  2) 쌓인 데이터가 한 시즌뿐이라 계절과 유행을 가를 수 없다. 반팔이 9월에 줄어든 건
 *     유행이 아니라 가을이다. 전년 동기와 비교할 수 있어야 비로소 갈린다.
 *
 * 산출물: data/category_timeline.json
 * 사용법: node build_category_timeline.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "category_timeline.json");

const MIN_PEAK_ITEMS = 10;  // 주 최대치가 이보다 적은 품목은 흔들림이 커서 뺀다
const MIN_WEEKS = 6;        // 추세를 말하려면 최소 이만큼은 있어야 한다
const SMOOTH = 3;           // 이동평균 주 수
const TURN_RATIO = 0.65;    // 정점의 65% 밑으로 내려오면 "줄기 시작했다"로 본다
const RISE_RATIO = 1.5;     // 저점의 1.5배를 넘으면 "늘기 시작했다"

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (v) => Math.round(v * 10) / 10;

/* ISO 주차 키 (build_trend_archive.js와 같은 규칙) */
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return year + "-W" + String(week).padStart(2, "0");
}

function mondayOf(isoKey) {
  const [y, w] = isoKey.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon1 = new Date(jan4);
  mon1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const d = new Date(mon1);
  d.setUTCDate(mon1.getUTCDate() + (w - 1) * 7);
  return d;
}

/*
 * "2026-W45" -> "11월 1째주".
 * 주가 달에 걸칠 때는 그 주의 목요일이 속한 달로 보낸다 - 더 많은 날이 속한 달로 가는
 * 가장 간단한 규칙이고, ISO 주차가 연도를 정하는 방식과도 같다.
 */
function weekLabel(isoKey) {
  const thu = mondayOf(isoKey);
  thu.setUTCDate(thu.getUTCDate() + 3);
  const month = thu.getUTCMonth() + 1;
  const nth = Math.floor((thu.getUTCDate() - 1) / 7) + 1;
  const mon = mondayOf(isoKey);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    year: thu.getUTCFullYear(), month, nth,
    text: `${month}월 ${nth}째주`,
    range: `${iso(mon).slice(5)} ~ ${iso(sun).slice(5)}`,
    monday: iso(mon),
  };
}

/* 한 주에 올라온 서로 다른 상품을 품목별로 센다. 같은 상품이 여러 날/여러 카테고리에
   걸쳐도 한 번만 센다 - 그래야 "그 주에 이 품목이 몇 종 올라왔나"가 된다. */
function countWeek(days, index, meta) {
  const seen = new Set();
  const byCat = new Map();
  let total = 0;
  for (const d of days) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[times.length - 1]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of (snap[cat] && snap[cat].all) || []) {
        const id = idOf(it.url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const m = meta[id];
        if (!m || !m.cat2) continue;
        total += 1;
        byCat.set(m.cat2, (byCat.get(m.cat2) || 0) + 1);
      }
    }
  }
  return { byCat, total };
}

/* 이동평균. 양 끝은 있는 만큼만 쓴다(처음 두 주를 버리지 않으려고). */
function smooth(arr, win) {
  return arr.map((_, i) => {
    const from = Math.max(0, i - Math.floor(win / 2));
    const to = Math.min(arr.length, from + win);
    return avg(arr.slice(from, to));
  });
}

/*
 * "언제부터 줄기 시작했나"를 찾는다.
 *
 * 정점이 언제였는지를 찾는 방식은 쓸 수 없었다. 후드집업처럼 8~9월 내내 2.5~3% 사이를
 * 오르내리다 꺾이는 모양에서는, 그 구간의 들쭉날쭉한 최고점(8월 2째주)이 집히는데
 * 그건 "줄기 시작한 때"가 아니다. 사람이 그래프를 볼 때 집는 건 평평하던 구간을
 * 벗어나는 지점이다.
 *
 * 그래서 정점(P)과 지금(N) 사이에 문턱을 하나 긋고(정점에서 25% 내려온 높이),
 * 그 문턱 위에 마지막으로 있었던 주를 "여기서부터 빠지기 시작했다"로 본다.
 * 늘어나는 쪽은 저점과 지금 사이에 같은 식으로 긋는다.
 */
const TURN_BAND = 0.25;

function departureIndex(sm, level, goingDown) {
  // 문턱을 마지막으로 넘고 있던 주. 그 다음 주부터 추세가 시작된 것으로 읽는다.
  let at = 0;
  sm.forEach((v, i) => { if (goingDown ? v >= level : v <= level) at = i; });
  return at;
}

function findTurn(series) {
  const sm = smooth(series.map((s) => s.pct), SMOOTH);
  const now = avg(sm.slice(-Math.min(3, sm.length)));
  const peak = Math.max(...sm);
  const trough = Math.min(...sm);

  if (peak > 0 && now < peak * TURN_RATIO) {
    const at = departureIndex(sm, peak - TURN_BAND * (peak - now), true);
    return {
      dir: "down", at: series[at].w, from: r1(peak), now: r1(now),
      // 수집 첫 주부터 이미 빠지고 있었다면 "언제부터"를 말할 수 없다. 화면에서 다르게 쓴다.
      atStart: at === 0,
    };
  }
  if (now > Math.max(trough, 0.1) * RISE_RATIO) {
    const at = departureIndex(sm, trough + TURN_BAND * (now - trough), false);
    return { dir: "up", at: series[at].w, from: r1(trough), now: r1(now), atStart: at === 0 };
  }
  return { dir: "flat", at: null, from: r1(avg(sm.slice(0, 3))), now: r1(now), atStart: false };
}

function run() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));

  const byWeek = new Map();
  for (const d of Object.keys(index).sort()) {
    const k = isoWeekKey(d);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(d);
  }
  const weekKeys = [...byWeek.keys()].sort();

  const counts = weekKeys.map((wk) => countWeek(byWeek.get(wk), index, meta));
  const cats = new Set();
  counts.forEach((c) => c.byCat.forEach((_, k) => cats.add(k)));

  const categories = {};
  for (const cat of cats) {
    const series = weekKeys.map((wk, i) => {
      const n = counts[i].byCat.get(cat) || 0;
      return { w: wk, n, pct: counts[i].total ? r1((n / counts[i].total) * 100) : 0 };
    });
    const peakN = Math.max(...series.map((s) => s.n));
    if (peakN < MIN_PEAK_ITEMS || series.length < MIN_WEEKS) continue;
    const sample = meta[Object.keys(meta).find((id) => meta[id] && meta[id].cat2 === cat)];
    categories[cat] = {
      cat1: (sample && sample.cat1) || "",
      series,
      turn: findTurn(series),
      peakN,
      nowN: avg(series.slice(-3).map((s) => s.n)),
    };
  }

  // 변화가 큰 품목이 위로 오게 정렬한다 - 안 변한 품목은 볼 이유가 적다.
  const score = (c) => {
    const t = categories[c].turn;
    if (t.dir === "flat") return 0;
    return Math.abs(t.now - t.from);
  };
  const order = Object.keys(categories).sort((a, b) => score(b) - score(a));

  const out = {
    updatedAt: new Date().toISOString().slice(0, 10),
    weeks: weekKeys.map((wk) => ({ w: wk, ...weekLabel(wk) })),
    order,
    categories,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  console.log(`category_timeline.json 저장 (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB)`);
  console.log(`  주차 ${weekKeys.length}개 (${weekLabel(weekKeys[0]).text} ~ ${weekLabel(weekKeys[weekKeys.length - 1]).text}) / 품목 ${order.length}개`);
  for (const c of order.slice(0, 10)) {
    const t = categories[c].turn;
    const when = t.at ? weekLabel(t.at).text : "-";
    const arrow = t.dir === "down" ? "줄기 시작" : t.dir === "up" ? "늘기 시작" : "유지";
    console.log(`  ${c.padEnd(20)} ${arrow.padEnd(8)} ${when.padEnd(10)} ${t.from}% -> ${t.now}%`);
  }
}

if (require.main === module) run();
module.exports = { weekLabel, isoWeekKey, findTurn, smooth };
