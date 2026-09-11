/*
 * 자사 브랜드(비바라비다)가 무신사에 올려둔 상품 "전부"를 받아온다.
 *
 * 랭킹 스냅샷에는 TOP150에 든 상품만 있어서, 우리 상품 419개 중 랭킹에 들어본 32개밖에 보이지
 * 않는다. "왜 나머지 387개는 못 들어갔나"를 보려면 카탈로그 전체가 필요하다.
 *
 * 쓰는 API (브랜드 플래그십 페이지가 쓰는 것과 동일, 인증 없음):
 *   GET api2/dp/v2/plp/goods?brand={slug}&sortCode=POPULAR&size=100&caller=FLAGSHIP...
 *
 * 주의: 2페이지부터는 page=N을 직접 붙이면 빈 배열이 온다. 응답의 pagination.nextPageUrl에
 * 서명값(hmacId)이 들어있어서, 그 URL을 그대로 따라가야 한다.
 *
 * 카탈로그를 받은 뒤 아직 상세 속성이 없는 상품은 scrape_product_meta의 수집기로 채워서,
 * 랭킹 상위권과 핏/실측/이미지 장수까지 비교할 수 있게 한다.
 *
 * 사용법:
 *   node scrape_brand_catalog.js                 # 기본 브랜드(비바라비다)
 *   node scrape_brand_catalog.js --brand slug    # 다른 브랜드
 *   node scrape_brand_catalog.js --no-meta       # 카탈로그만, 상세 속성 수집 생략
 */

const fs = require("fs");
const path = require("path");
const { fetchOne, writeMeta, META_FILE } = require("./scrape_product_meta.js");

const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "brand_catalog.json");

const DEFAULT_BRAND = "vivalavida";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};
const PAGE_SIZE = 100;
const META_CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const firstPageUrl = (brand) =>
  `https://api.musinsa.com/api2/dp/v2/plp/goods?brand=${encodeURIComponent(brand)}` +
  `&sortCode=POPULAR&size=${PAGE_SIZE}&page=1&caller=FLAGSHIP&countryCode=KR&localeCode=ko-KR&gf=A`;

/* PLP가 주는 상품 한 건에서 진단에 쓸 값만 남긴다. PLP의 reviewScore는 0~100 스케일인데
   상세 API(goodsReview.satisfactionScore)는 0~5라서, 5점 만점으로 맞춰 저장한다. */
function mapGoods(g) {
  return {
    id: String(g.goodsNo),
    name: g.goodsName || "",
    price: g.finalPrice ?? g.price ?? null,
    normalPrice: g.normalPrice ?? null,
    discount: g.finalDiscount ?? g.saleRate ?? null,
    reviews: typeof g.reviewCount === "number" ? g.reviewCount : null,
    reviewScore: typeof g.reviewScore === "number" && g.reviewScore > 0 ? g.reviewScore / 20 : null,
    soldOut: !!g.isSoldOut,
    gender: g.displayGenderText || "",
  };
}

async function fetchCatalog(brand) {
  let url = firstPageUrl(brand);
  const items = [];
  let total = null, brandName = "";
  while (url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const d = j.data || {};
    for (const g of d.list || []) {
      items.push(mapGoods(g));
      if (!brandName && g.brandName) brandName = g.brandName;
    }
    const p = d.pagination || {};
    if (total === null) total = p.totalCount ?? null;
    url = p.hasNext ? p.nextPageUrl : null;
    if (url) await sleep(300);
  }
  return { brand, brandName, total, items };
}

/* 카탈로그 중 상세 속성이 아직 없는 상품을 채운다 (핏/실측/이미지 장수 비교용) */
async function fillMeta(ids) {
  const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, "utf8")) : {};
  const todo = ids.filter((id) => !meta[id]);
  if (!todo.length) return { meta, added: 0 };
  let cursor = 0, done = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const id = todo[i];
      try {
        const r = await fetchOne(id);
        meta[id] = r.gone ? { gone: true } : r.record;
      } catch { /* 실패한 건 캐시에 안 넣어서 다음 실행에 재시도된다 */ }
      done += 1;
      if (done % 100 === 0) console.log(`  상세 속성 ${done}/${todo.length}`);
      await sleep(150);
    }
  };
  await Promise.all(Array.from({ length: META_CONCURRENCY }, worker));
  writeMeta(meta);
  return { meta, added: todo.length };
}

/* "이 상품이 랭킹에 든 적 있나"는 수집일 전체 스냅샷을 훑어야 알 수 있다. 브라우저에서 하면
   1.2MB짜리 파일을 수십 개 받아야 하므로, 여기서 미리 계산해 상품마다 붙여둔다.
   bestRank는 그 기간 중 가장 높았던 순위("전체" 카테고리 기준), rankedDays는 며칠이나 들었는지. */
function markRankingHistory(items) {
  const indexFile = path.join(DATA_DIR, "musinsa_index.json");
  if (!fs.existsSync(indexFile)) return { days: 0 };
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  const dates = Object.keys(index).sort();
  const byId = new Map(items.map((it) => [it.id, it]));

  for (const d of dates) {
    const times = index[d] || [];
    if (!times.length) continue;
    const file = path.join(DATA_DIR, `musinsa_${d}_${times[0]}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const seenToday = new Set();
    for (const cat of Object.keys(snap)) {
      if (cat === "keywords") continue;
      for (const it of snap[cat]?.all || []) {
        const id = (String(it.url || "").match(/products\/(\d+)/) || [])[1];
        const row = id && byId.get(id);
        if (!row) continue;
        if (cat === "전체" && typeof it.rank === "number") {
          row.bestRank = row.bestRank === undefined ? it.rank : Math.min(row.bestRank, it.rank);
        }
        if (!seenToday.has(id)) { seenToday.add(id); row.rankedDays = (row.rankedDays || 0) + 1; }
      }
    }
  }
  return { days: dates.length };
}

async function run() {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--brand");
  const brand = bi !== -1 ? args[bi + 1] : DEFAULT_BRAND;
  const skipMeta = args.includes("--no-meta");

  console.log(`브랜드 카탈로그 수집: ${brand}`);
  const cat = await fetchCatalog(brand);
  console.log(`  ${cat.brandName || brand} 상품 ${cat.items.length}개 (API 총계 ${cat.total})`);

  if (!skipMeta) {
    const { added } = await fillMeta(cat.items.map((i) => i.id));
    console.log(`  상세 속성 신규 수집 ${added}개`);
  }

  const { days } = markRankingHistory(cat.items);
  const rankedCount = cat.items.filter((i) => i.rankedDays).length;
  console.log(`  랭킹 이력: 최근 ${days}일 중 TOP150 진입 경험 ${rankedCount}개`);

  /* 브랜드별로 모아두되, 한 줄에 한 상품씩 써서 git 델타가 작게 남도록 한다 */
  const all = fs.existsSync(CATALOG_FILE) ? JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")) : {};
  all[brand] = { brandName: cat.brandName, total: cat.total, snapshotDays: days, updatedAt: new Date().toISOString().slice(0, 10), items: cat.items };
  const lines = Object.keys(all).sort().map((b) => {
    const v = all[b];
    const itemLines = v.items.map((it) => `  ${JSON.stringify(it)}`).join(",\n");
    return `${JSON.stringify(b)}:{"brandName":${JSON.stringify(v.brandName)},"total":${v.total},"snapshotDays":${v.snapshotDays || 0},"updatedAt":${JSON.stringify(v.updatedAt)},"items":[\n${itemLines}\n]}`;
  });
  fs.writeFileSync(CATALOG_FILE, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`  저장: brand_catalog.json (${(fs.statSync(CATALOG_FILE).size / 1024).toFixed(0)}KB)`);
}

if (require.main === module) {
  run().catch((e) => { console.error("실패:", e); process.exit(1); });
}

module.exports = { fetchCatalog, mapGoods };
