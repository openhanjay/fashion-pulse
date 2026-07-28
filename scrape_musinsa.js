/*
 * 무신사 랭킹(전체/급상승/NEW x 6개 카테고리)을 수집해서 날짜+시간별 파일로 저장하는 스크립트.
 * 하루에 여러 번(예: 08:00, 17:00) 실행하는 것을 전제로 한다.
 *
 * 사용법:
 *   node scrape_musinsa.js
 *
 * 실행할 때마다:
 *   data/musinsa_YYYY-MM-DD_HH-mm.json   (그 시점 수집한 랭킹 데이터)
 *   data/musinsa_index.json              (날짜 -> 수집 시간 목록 매핑, 자동 누적/갱신)
 * 을 만들거나 갱신한다. 기존 파일은 덮어쓰지 않으므로 하루에 여러 번, 여러 날에 걸쳐 실행하면
 * 기록이 계속 쌓인다.
 *
 * musinsa_index.json 형태 예시:
 *   { "2026-07-28": ["08-05", "17-12"], "2026-07-29": ["08-02"] }
 *
 * fashion_marketer_dashboard.html과 같은 폴더에서 로컬 서버(node serve.js)로 열면,
 * "데이터 조회" 달력에서 날짜를 고르고, 그 날짜의 수집 시간대(평균/각 시간)를 골라 볼 수 있다.
 * Node 18 이상 (전역 fetch 사용) 필요.
 */

const fs = require("fs");
const path = require("path");

// 주의: /api/home/web/v5/pans/ranking (페이지 최초 로드용) 는 sectionId=201(급상승)에서
// categoryCode를 무시하고 항상 "전체" 결과만 반환한다(실제 확인됨). 카테고리별 급상승을 제대로
// 받으려면 무신사 프론트가 탭 전환 시 실제로 쓰는 /pans/ranking/sections/{sectionId} 엔드포인트를 써야 한다.
const BASE_URL = "https://client.musinsa.com/api/home/web/v5/pans/ranking/sections";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// 대시보드 카테고리 <-> 무신사 categoryCode ("전체" = 카테고리 구분 없는 전체 랭킹)
const CATEGORY_CODES = {
  전체: "000",
  상의: "001000",
  아우터: "002000",
  바지: "003000",
  원피스: "100000",
  가방: "004000",
  모자: "120000",
};

// 대시보드 랭킹 필터 <-> 무신사 sectionId
const SECTION_IDS = {
  all: "199",
  new: "200",
  rising: "201",
};

const REQUEST_DELAY_MS = 700;
const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "musinsa_index.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 실행 서버의 로컬 타임존과 무관하게 항상 한국 시간(KST, UTC+9) 기준으로 날짜/시각을 계산한다.
// (GitHub Actions 등 UTC 서버에서 돌려도 KST 기준 파일명이 나오도록 하기 위함)
function toKst(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function todayDateString(now) {
  const k = toKst(now);
  return `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())}`;
}

function nowTimeString(now) {
  const k = toKst(now);
  return `${pad2(k.getUTCHours())}-${pad2(k.getUTCMinutes())}`;
}

async function fetchRanking(sectionId, categoryCode) {
  const params = new URLSearchParams({
    storeCode: "musinsa",
    contentsId: "",
    categoryCode,
    gf: "A",
    ageBand: "AGE_BAND_ALL",
    period: "REALTIME",
    soldOut: "true",
  });
  const res = await fetch(`${BASE_URL}/${sectionId}?${params.toString()}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} (sectionId=${sectionId}, categoryCode=${categoryCode})`);
  return res.json();
}

function extractProducts(payload) {
  const modules = payload?.data?.modules || [];
  const products = [];
  for (const module of modules) {
    if (module.type !== "MULTICOLUMN") continue;
    for (const item of module.items || []) {
      if (item.type !== "PRODUCT_COLUMN") continue;
      const info = item.info || {};
      const image = item.image || {};
      const labels = image.labels || [];
      products.push({
        rank: image.rank ?? null,
        brand: info.brandName || "",
        name: info.productName || "",
        price: info.finalPrice || 0,
        discountRatio: info.discountRatio || 0,
        image: image.url || "",
        url: item.onClick?.url || "",
        badge: labels[0]?.text || null,
      });
    }
  }
  products.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  return products.slice(0, 100);
}

function updateIndex(dateStr, timeStr) {
  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) index = parsed;
    } catch {
      index = {};
    }
  }
  if (!Array.isArray(index[dateStr])) index[dateStr] = [];
  if (!index[dateStr].includes(timeStr)) index[dateStr].push(timeStr);
  index[dateStr].sort();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
  return index;
}

async function main() {
  const result = {};
  for (const [category, categoryCode] of Object.entries(CATEGORY_CODES)) {
    result[category] = {};
    for (const [filterKey, sectionId] of Object.entries(SECTION_IDS)) {
      console.log(`수집 중: ${category} / ${filterKey} ...`);
      const payload = await fetchRanking(sectionId, categoryCode);
      result[category][filterKey] = extractProducts(payload);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const now = new Date();
  const dateStr = todayDateString(now);
  const timeStr = nowTimeString(now);
  const outFile = path.join(DATA_DIR, `musinsa_${dateStr}_${timeStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  const index = updateIndex(dateStr, timeStr);

  console.log(`완료: data/musinsa_${dateStr}_${timeStr}.json 저장됨`);
  console.log(`${dateStr} 누적 수집 시각: ${index[dateStr].join(", ")}`);
}

main().catch((err) => {
  console.error("스크래핑 실패:", err);
  process.exit(1);
});
