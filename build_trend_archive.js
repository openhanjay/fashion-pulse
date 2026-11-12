/*
 * 주간/월간 "디자인 지문"을 쌓아두는 적립 스크립트.
 *
 * 왜 쌓나: 랭킹 스냅샷은 그때그때의 사진일 뿐이라, "요즘 어떤 디자인이 상위에 많은가"를
 * 시간축으로 보려면 기간별 요약을 따로 남겨야 한다. 주 단위로 한 번 집계해 얼려두고,
 * 그 주들을 묶어 월 단위를 만든다. 이렇게 1년을 모으면 전년 동기 대비가 가능해진다
 * (지금은 한 시즌치뿐이라 "내년엔 이게 유행"을 말할 근거는 아직 없다).
 *
 * 지나간 주는 더 변하지 않으므로 한 번 만들면 다시 계산하지 않는다(--rebuild로 강제 가능).
 * 이번 주만 수집할 때마다 갱신된다.
 *
 * 산출물
 *   data/trend/weekly/2026-W45.json   그 주의 지문
 *   data/trend/monthly/2026-11.json   그 달 주간들의 묶음
 *   data/trend/index.json             기간 목록 + 대시보드가 먼저 읽는 요약
 *
 * 사용법: node build_trend_archive.js [--rebuild]
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const TREND_DIR = path.join(DATA_DIR, "trend");
const WEEK_DIR = path.join(TREND_DIR, "weekly");
const MONTH_DIR = path.join(TREND_DIR, "monthly");

const TOP_CATEGORIES = 16;
const TOP_COLORS = 12;
const TOP_WORDS = 20;
const MEASURE_MIN = 12; // 품목별 실측 평균을 낼 최소 표본
const WORD_MIN = 4;     // 상품명 키워드 최소 등장 수

const idOf = (u) => (String(u || "").match(/products\/(\d+)/) || [])[1];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const pct = (n, base) => Math.round((n / Math.max(1, base)) * 1000) / 10;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* 상품명에서 색상을 뽑는다. 대시보드의 COLOR_ALIASES와 같은 어휘를 쓴다. */
const COLOR_ALIASES = {
  "블랙": "블랙", black: "블랙", "화이트": "화이트", white: "화이트",
  "그레이": "그레이", "회색": "그레이", gray: "그레이", grey: "그레이",
  "네이비": "네이비", navy: "네이비", "베이지": "베이지", beige: "베이지",
  "브라운": "브라운", brown: "브라운", "카키": "카키", khaki: "카키",
  "아이보리": "아이보리", ivory: "아이보리", "그린": "그린", green: "그린",
  "레드": "레드", red: "레드", "블루": "블루", blue: "블루",
  "옐로우": "옐로우", yellow: "옐로우", "핑크": "핑크", pink: "핑크",
  "퍼플": "퍼플", purple: "퍼플", "오렌지": "오렌지", orange: "오렌지",
  "실버": "실버", silver: "실버", "골드": "골드", gold: "골드",
  "차콜": "차콜", charcoal: "차콜", "버건디": "버건디", burgundy: "버건디",
  "와인": "와인", wine: "와인", "민트": "민트", mint: "민트",
  "라벤더": "라벤더", lavender: "라벤더", "코랄": "코랄", coral: "코랄",
  "머스타드": "머스타드", mustard: "머스타드", "크림": "크림", cream: "크림",
  "카멜": "카멜", camel: "카멜",
};
const colorOf = (w) => COLOR_ALIASES[w] || COLOR_ALIASES[w.toLowerCase()];

/* 품목 이름을 그대로 옮긴 단어는 키워드로서 정보가 없다("티셔츠"가 티셔츠에 많은 건 당연). */
const STOPWORDS = new Set([
  "세트", "패키지", "기획", "단독", "한정", "컬러", "color", "colors", "pack", "set",
  "티셔츠", "티", "반팔", "긴팔", "셔츠", "맨투맨", "후드", "후드티", "스웨트", "탑", "블라우스",
  "자켓", "재킷", "코트", "점퍼", "패딩", "가디건", "베스트", "집업", "니트", "스웨터",
  "팬츠", "슬랙스", "데님", "청바지", "반바지", "원피스", "드레스", "스커트", "치마",
  "shirt", "tee", "hoodie", "jacket", "coat", "pants", "denim", "jeans", "dress", "skirt", "knit",
]);

const PRICE_BANDS = [
  ["~2만", (p) => p < 20000], ["2~4만", (p) => p >= 20000 && p < 40000],
  ["4~6만", (p) => p >= 40000 && p < 60000], ["6~10만", (p) => p >= 60000 && p < 100000],
  ["10~20만", (p) => p >= 100000 && p < 200000], ["20만~", (p) => p >= 200000],
];
const DISCOUNT_BANDS = [
  ["세일 없음", (d) => d <= 0], ["1~19%", (d) => d > 0 && d < 20],
  ["20~39%", (d) => d >= 20 && d < 40], ["40~59%", (d) => d >= 40 && d < 60], ["60%~", (d) => d >= 60],
];

/* ISO 주차 키. 목요일이 속한 해를 그 주의 해로 본다(연말연시 주가 쪼개지지 않게). */
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return year + "-W" + String(week).padStart(2, "0");
}

/*
 * 지문 하나를 만든다. 모든 분포는 { base, rows:[{k,n,pct}] } 꼴로 통일했다 -
 * base가 분모이고, 주간과 월간이 같은 모양이어야 대시보드가 둘을 똑같이 그린다.
 * 핏/계절처럼 한 상품이 값을 여러 개 갖는 항목은 pct 합이 100%를 넘는다(의도한 것).
 */
function fingerprint(products) {
  const withMeta = products.filter((p) => p.meta);
  const pack = (map, base, limit, minN) => ({
    base,
    rows: [...map.entries()].filter(([, n]) => !minN || n >= minN)
      .sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([k, n]) => ({ k, n, pct: pct(n, base) })),
  });

  const catMap = new Map();
  for (const p of withMeta) if (p.meta.cat2) catMap.set(p.meta.cat2, (catMap.get(p.meta.cat2) || 0) + 1);

  // 속성은 "봄/가을"처럼 슬래시로 여러 값이 들어온다. 값마다 하나씩 세고, 분모는 그 속성을 가진 상품 수.
  const packAttr = (key) => {
    const m = new Map(); let base = 0;
    for (const p of withMeta) {
      const v = p.meta[key];
      if (!v) continue;
      base += 1;
      for (const one of String(v).split("/")) m.set(one, (m.get(one) || 0) + 1);
    }
    return pack(m, base, 8);
  };

  /* 품목별 실측 평균 - 디자인 변화를 숫자로 잡는 가장 단단한 지표 */
  const bucketed = {};
  for (const p of withMeta) {
    const c = p.meta.cat2, ms = p.meta.measure;
    if (!c || !ms) continue;
    const g = (bucketed[c] = bucketed[c] || {});
    for (const [k, v] of Object.entries(ms)) if (typeof v === "number" && v > 0) (g[k] = g[k] || []).push(v);
  }
  const measure = {};
  for (const [c, g] of Object.entries(bucketed)) {
    const out = {};
    for (const [k, arr] of Object.entries(g)) if (arr.length >= MEASURE_MIN) out[k] = { avg: r1(avg(arr)), n: arr.length };
    if (Object.keys(out).length) measure[c] = out;
  }

  /* 상품명에서 색상과 키워드. 한 상품 안에서 같은 단어가 반복돼도 한 번만 센다. */
  const colorM = new Map(), lowerM = new Map(), spelling = new Map();
  for (const p of products) {
    const seenC = new Set(), seenW = new Set();
    for (const raw of String(p.name || "").split(/[\s/_\-[\]().,]+/)) {
      const w = raw.trim();
      if (w.length < 2 || /^\d+$/.test(w)) continue;
      const c = colorOf(w);
      if (c) { if (!seenC.has(c)) { seenC.add(c); colorM.set(c, (colorM.get(c) || 0) + 1); } continue; }
      const lw = w.toLowerCase();
      if (STOPWORDS.has(w) || STOPWORDS.has(lw)) continue;
      if (seenW.has(lw)) continue;
      seenW.add(lw);
      lowerM.set(lw, (lowerM.get(lw) || 0) + 1);
      // 대소문자만 다른 표기는 한 단어로 묶되, 화면에는 가장 흔한 표기를 보여준다("BAG" vs "Bag").
      const sp = spelling.get(lw) || new Map();
      sp.set(w, (sp.get(w) || 0) + 1);
      spelling.set(lw, sp);
    }
  }
  const wordM = new Map();
  for (const [lw, n] of lowerM) {
    const best = [...spelling.get(lw).entries()].sort((a, b) => b[1] - a[1])[0][0];
    wordM.set(best, n);
  }

  const bandsOf = (vals, bands) => ({
    base: vals.length,
    rows: bands.map(([label, test]) => ({ k: label, n: vals.filter(test).length }))
      .filter((b) => b.n > 0).map((b) => ({ ...b, pct: pct(b.n, vals.length) })),
  });

  const prices = products.map((p) => p.price).filter((v) => typeof v === "number" && v > 0);
  const discounts = products.map((p) => p.discountRatio).filter((v) => typeof v === "number");
  const images = withMeta.map((p) => p.meta.images).filter((v) => typeof v === "number");
  const reviews = withMeta.map((p) => p.meta.reviews).filter((v) => typeof v === "number" && v >= 0);

  return {
    products: products.length,
    withMeta: withMeta.length,
    coverage: pct(withMeta.length, products.length),
    categories: pack(catMap, withMeta.length, TOP_CATEGORIES),
    fit: packAttr("fit"),
    thickness: packAttr("thickness"),
    sheer: packAttr("sheer"),
    stretch: packAttr("stretch"),
    season: packAttr("season"),
    sex: packAttr("sex"),
    colors: pack(colorM, products.length, TOP_COLORS),
    words: pack(wordM, products.length, TOP_WORDS, WORD_MIN),
    measure,
    price: { median: median(prices), avg: r1(avg(prices)), ...bandsOf(prices, PRICE_BANDS) },
    discount: { avg: r1(avg(discounts)), ...bandsOf(discounts, DISCOUNT_BANDS) },
    images: r1(avg(images)),
    reviews: median(reviews),
  };
}

/*
 * 한 주에 속한 날들의 스냅샷에서 중복 없는 상품 목록을 만든다.
 * 같은 상품이 여러 날 랭킹에 있어도 한 번만 센다 - 그래야 "그 주에 어떤 상품이 상위에 있었나"가 된다.
 * 하루 4회 수집하지만 같은 날 시각별 구성은 거의 같으므로 하루 한 스냅샷만 읽는다.
 */
function collectWeek(days, index, meta) {
  const byId = new Map();
  for (const d of days) {
    for (const t of index[d] || []) {
      const file = path.join(DATA_DIR, "musinsa_" + d + "_" + t + ".json");
      if (!fs.existsSync(file)) continue;
      const snap = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const cat of Object.keys(snap)) {
        if (cat === "keywords") continue;
        for (const it of (snap[cat] && snap[cat].all) || []) {
          const id = idOf(it.url);
          if (!id || byId.has(id)) continue;
          byId.set(id, { id, name: it.name, price: it.price, discountRatio: it.discountRatio, meta: meta[id] || null });
        }
      }
      break;
    }
  }
  return [...byId.values()];
}

/*
 * 주간을 월간으로 묶는다. 각 항목의 분자(n)와 분모(base)를 그대로 더해 다시 비중을 낸다 -
 * 비중의 평균을 내면 수집일이 적은 주가 많은 주와 같은 무게를 갖게 되므로 그렇게 하지 않는다.
 */
function rollup(weeks) {
  const mergeDist = (key, limit, keepOrder) => {
    const m = new Map(); let base = 0;
    for (const w of weeks) {
      const sec = w[key];
      if (!sec) continue;
      base += sec.base || 0;
      for (const r of sec.rows || []) m.set(r.k, (m.get(r.k) || 0) + r.n);
    }
    let entries = [...m.entries()];
    // 가격/할인 밴드는 싼 쪽 -> 비싼 쪽 순서가 의미를 가지므로 정렬하지 않는다.
    if (keepOrder) entries = keepOrder.map(([l]) => l).filter((l) => m.has(l)).map((l) => [l, m.get(l)]);
    else entries.sort((a, b) => b[1] - a[1]);
    return { base, rows: entries.slice(0, limit).map(([k, n]) => ({ k, n, pct: pct(n, base) })) };
  };

  /* 실측은 표본 수로 가중해 다시 평균 낸다 */
  const acc = {};
  for (const w of weeks) {
    for (const [cat, g] of Object.entries(w.measure || {})) {
      const t = (acc[cat] = acc[cat] || {});
      for (const [k, v] of Object.entries(g)) {
        const a = (t[k] = t[k] || { sum: 0, n: 0 });
        a.sum += v.avg * v.n; a.n += v.n;
      }
    }
  }
  const measure = {};
  for (const [cat, g] of Object.entries(acc)) {
    measure[cat] = {};
    for (const [k, v] of Object.entries(g)) measure[cat][k] = { avg: r1(v.sum / v.n), n: v.n };
  }

  const wAvg = (pick) => {
    let s = 0, n = 0;
    for (const w of weeks) { const v = pick(w); if (typeof v === "number") { s += v * w.products; n += w.products; } }
    return n ? r1(s / n) : null;
  };

  const totalProducts = weeks.reduce((a, w) => a + w.products, 0);
  const totalMeta = weeks.reduce((a, w) => a + w.withMeta, 0);
  return {
    products: totalProducts,
    withMeta: totalMeta,
    coverage: pct(totalMeta, totalProducts),
    categories: mergeDist("categories", TOP_CATEGORIES),
    fit: mergeDist("fit", 8), thickness: mergeDist("thickness", 8), sheer: mergeDist("sheer", 8),
    stretch: mergeDist("stretch", 8), season: mergeDist("season", 8), sex: mergeDist("sex", 8),
    colors: mergeDist("colors", TOP_COLORS),
    words: mergeDist("words", TOP_WORDS),
    measure,
    price: { median: wAvg((w) => w.price && w.price.median), avg: wAvg((w) => w.price && w.price.avg), ...mergeDist("price", 8, PRICE_BANDS) },
    discount: { avg: wAvg((w) => w.discount && w.discount.avg), ...mergeDist("discount", 8, DISCOUNT_BANDS) },
    images: wAvg((w) => w.images),
    reviews: wAvg((w) => w.reviews),
  };
}

function run() {
  const rebuild = process.argv.includes("--rebuild");
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "musinsa_index.json"), "utf8"));
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "product_meta_slim.json"), "utf8"));
  fs.mkdirSync(WEEK_DIR, { recursive: true });
  fs.mkdirSync(MONTH_DIR, { recursive: true });

  const byWeek = new Map();
  for (const d of Object.keys(index).sort()) {
    const k = isoWeekKey(d);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(d);
  }
  const weekKeys = [...byWeek.keys()].sort();
  const currentWeek = isoWeekKey(new Date().toISOString().slice(0, 10));

  let built = 0, kept = 0;
  for (const wk of weekKeys) {
    const file = path.join(WEEK_DIR, wk + ".json");
    // 지나간 주는 더 변하지 않는다. 이번 주만 다시 만든다.
    if (!rebuild && wk !== currentWeek && fs.existsSync(file)) { kept += 1; continue; }
    const days = byWeek.get(wk);
    const products = collectWeek(days, index, meta);
    if (!products.length) continue;
    fs.writeFileSync(file, JSON.stringify({
      period: wk, kind: "week", from: days[0], to: days[days.length - 1], days: days.length,
      ...fingerprint(products),
    }));
    built += 1;
  }

  const weeks = weekKeys.map((wk) => {
    const f = path.join(WEEK_DIR, wk + ".json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  }).filter(Boolean);

  // 주가 달에 걸치면 끝나는 날 기준으로 귀속시킨다(그 주의 대부분이 그 달에 속한다).
  const byMonth = new Map();
  for (const w of weeks) {
    const m = w.to.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(w);
  }
  for (const [m, ws] of byMonth) {
    fs.writeFileSync(path.join(MONTH_DIR, m + ".json"), JSON.stringify({
      period: m, kind: "month", weeks: ws.map((w) => w.period),
      from: ws[0].from, to: ws[ws.length - 1].to, days: ws.reduce((a, w) => a + w.days, 0),
      ...rollup(ws),
    }));
  }

  /* 대시보드가 기간 목록과 핵심 추이를 한 번에 읽도록 색인을 만든다 */
  const slim = (p) => ({
    period: p.period, from: p.from, to: p.to, days: p.days, products: p.products,
    fit: p.fit.rows.slice(0, 5),
    categories: p.categories.rows.slice(0, 6),
    priceMedian: p.price.median,
  });
  fs.writeFileSync(path.join(TREND_DIR, "index.json"), JSON.stringify({
    updatedAt: new Date().toISOString().slice(0, 10),
    weeks: weeks.map(slim),
    months: [...byMonth.keys()].sort().map((m) => slim(JSON.parse(fs.readFileSync(path.join(MONTH_DIR, m + ".json"), "utf8")))),
  }));

  const size = (d) => fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0);
  console.log("주간 " + weeks.length + "개 (새로 " + built + ", 유지 " + kept + ") / 월간 " + byMonth.size + "개");
  console.log("  weekly " + (size(WEEK_DIR) / 1024).toFixed(0) + "KB, monthly " + (size(MONTH_DIR) / 1024).toFixed(0) + "KB, index " + (fs.statSync(path.join(TREND_DIR, "index.json")).size / 1024).toFixed(0) + "KB");
  console.log("  기간 " + (weeks[0] || {}).period + " ~ " + (weeks[weeks.length - 1] || {}).period);
}

if (require.main === module) run();
module.exports = { isoWeekKey, fingerprint, rollup };
