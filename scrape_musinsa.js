/*
 * 무신사 랭킹(전체/급상승/NEW x 7개 카테고리, TOP_N위까지)을 수집해서 날짜+시간별 파일로 저장하는 스크립트.
 * 하루에 여러 번(예: 08:00, 17:00) 실행하는 것을 전제로 한다.
 *
 * 사용법:
 *   node scrape_musinsa.js
 *
 * 실행할 때마다:
 *   data/musinsa_YYYY-MM-DD_HH-mm.json   (그 시점 수집한 랭킹 데이터, 전일 대비 순위 변동 포함)
 *   data/musinsa_index.json              (날짜 -> 수집 시간 목록 매핑, 자동 누적/갱신)
 * 을 만들거나 갱신한다. 기존 파일은 덮어쓰지 않으므로 하루에 여러 번, 여러 날에 걸쳐 실행하면
 * 기록이 계속 쌓인다.
 *
 * musinsa_index.json 형태 예시:
 *   { "2026-07-28": ["08-05", "17-12"], "2026-07-29": ["08-02"] }
 *
 * 순위 변동(item.delta)은 "가장 최근의 이전 날짜"에 수집된 데이터(그 날짜의 마지막 수집분) 대비
 * 오늘 순위가 몇 계단 올랐는지/내렸는지를 계산한다. 이전 날짜에 없던 상품이 새로 랭킹에 들어오면
 * "NEW"로 표시한다. 이전 날짜 데이터가 전혀 없으면(첫 수집 등) delta는 계산하지 않는다.
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
// 이 엔드포인트는 응답의 link.next를 따라가면 100위 이후(101~, 204~ ...)도 계속 받을 수 있다(확인됨).
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

// 검색어 랭킹 필터 <-> 무신사 sectionId (카테고리 구분 없는 전체 TOP 200. 급상승은 fluctuation 필드 자체가 없음)
const KEYWORD_SECTION_IDS = {
  all: "1067",
  rising: "2449",
};

const TOP_N = 150;
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

function buildInitialUrl(sectionId, categoryCode) {
  const params = new URLSearchParams({
    storeCode: "musinsa",
    contentsId: "",
    categoryCode,
    gf: "A",
    ageBand: "AGE_BAND_ALL",
    period: "REALTIME",
    soldOut: "true",
  });
  return `${BASE_URL}/${sectionId}?${params.toString()}`;
}

function mapItem(item) {
  const info = item.info || {};
  const image = item.image || {};
  const labels = image.labels || [];
  return {
    rank: image.rank ?? null,
    brand: info.brandName || "",
    name: info.productName || "",
    price: info.finalPrice || 0,
    discountRatio: info.discountRatio || 0,
    image: image.url || "",
    url: item.onClick?.url || "",
    badge: labels[0]?.text || null,
  };
}

// TOP_N에 도달하거나 다음 페이지가 없을 때까지 link.next를 따라가며 이어서 수집한다.
async function fetchRanking(sectionId, categoryCode) {
  let url = buildInitialUrl(sectionId, categoryCode);
  let rawItems = [];
  while (url && rawItems.length < TOP_N) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} (sectionId=${sectionId}, categoryCode=${categoryCode})`);
    const payload = await res.json();
    const modules = (payload?.data?.modules || []).filter((m) => m.type === "MULTICOLUMN");
    const pageItems = modules.flatMap((m) => (m.items || []).filter((i) => i.type === "PRODUCT_COLUMN"));
    if (pageItems.length === 0) break;
    rawItems = rawItems.concat(pageItems);
    url = payload?.link?.next || null;
    if (url && rawItems.length < TOP_N) await sleep(REQUEST_DELAY_MS);
  }
  return rawItems
    .map(mapItem)
    .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999))
    .slice(0, TOP_N);
}

// 검색어 랭킹은 한 번 요청에 최대 200개까지 다 오고 페이지네이션이 없음(link.next 없음)
function mapKeywordItem(item) {
  const f = item.fluctuation;
  let delta;
  if (f) {
    if (f.type === "NEW") delta = "NEW";
    else if (f.type === "UP") delta = Number(f.amount) || 0;
    else if (f.type === "DOWN") delta = -(Number(f.amount) || 0);
    else delta = 0;
  }
  return {
    rank: Number(item.rank) || 9999,
    keyword: item.title?.text || "",
    url: item.onClick?.url || "",
    ...(delta !== undefined ? { delta } : {}),
  };
}

async function fetchKeywordRanking(sectionId) {
  const res = await fetch(`${BASE_URL}/${sectionId}?storeCode=musinsa`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} (keyword sectionId=${sectionId})`);
  const payload = await res.json();
  const modules = (payload?.data?.modules || []).filter((m) => m.type === "RANKING_SEARCH");
  return modules.map(mapKeywordItem).sort((a, b) => a.rank - b.rank);
}

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function updateIndex(dateStr, timeStr) {
  const index = readIndex();
  if (!Array.isArray(index[dateStr])) index[dateStr] = [];
  if (!index[dateStr].includes(timeStr)) index[dateStr].push(timeStr);
  index[dateStr].sort();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
  return index;
}

// 오늘보다 이전 날짜 중 가장 최근 날짜를 찾는다 (문자열 정렬 = 날짜 정렬, YYYY-MM-DD 고정 폭이라 가능)
function findLatestPriorDate(index, todayStr) {
  const priorDates = Object.keys(index).filter((d) => d < todayStr).sort();
  return priorDates.length ? priorDates[priorDates.length - 1] : null;
}

function loadDateLatestSnapshot(dateStr, index) {
  const times = index[dateStr];
  if (!times || !times.length) return null;
  const latestTime = times[times.length - 1];
  const file = path.join(DATA_DIR, `musinsa_${dateStr}_${latestTime}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// 이전 날짜 스냅샷과 상품 URL 기준으로 매칭해서 순위 변동(delta)을 매긴다.
// 이전에 없던 상품은 "NEW", 이전 날짜 데이터 자체가 없으면 delta를 매기지 않는다.
function attachDeltas(today, prior) {
  if (!prior) return today;
  Object.keys(today).forEach((cat) => {
    Object.keys(today[cat]).forEach((filterKey) => {
      const priorList = prior?.[cat]?.[filterKey] || [];
      const priorRankByUrl = new Map(priorList.filter((it) => it.url).map((it) => [it.url, it.rank]));
      today[cat][filterKey] = today[cat][filterKey].map((item) => {
        if (!item.url || !priorRankByUrl.has(item.url)) return { ...item, delta: "NEW" };
        return { ...item, delta: priorRankByUrl.get(item.url) - item.rank };
      });
    });
  });
  return today;
}

async function main() {
  const now = new Date();
  const dateStr = todayDateString(now);
  const timeStr = nowTimeString(now);

  const indexBefore = readIndex();
  const priorDate = findLatestPriorDate(indexBefore, dateStr);
  const priorSnapshot = priorDate ? loadDateLatestSnapshot(priorDate, indexBefore) : null;
  console.log(priorDate ? `전일 대비 비교 기준: ${priorDate}` : "이전 날짜 데이터 없음 (순위 변동 표시 없이 저장)");

  const result = {};
  for (const [category, categoryCode] of Object.entries(CATEGORY_CODES)) {
    result[category] = {};
    for (const [filterKey, sectionId] of Object.entries(SECTION_IDS)) {
      console.log(`수집 중: ${category} / ${filterKey} ...`);
      result[category][filterKey] = await fetchRanking(sectionId, categoryCode);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  attachDeltas(result, priorSnapshot);

  result.keywords = {};
  for (const [filterKey, sectionId] of Object.entries(KEYWORD_SECTION_IDS)) {
    console.log(`수집 중: 검색어 / ${filterKey} ...`);
    result.keywords[filterKey] = await fetchKeywordRanking(sectionId);
    await sleep(REQUEST_DELAY_MS);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const outFile = path.join(DATA_DIR, `musinsa_${dateStr}_${timeStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  const index = updateIndex(dateStr, timeStr);

  console.log(`완료: data/musinsa_${dateStr}_${timeStr}.json 저장됨 (TOP ${TOP_N})`);
  console.log(`${dateStr} 누적 수집 시각: ${index[dateStr].join(", ")}`);
}

main().catch((err) => {
  console.error("스크래핑 실패:", err);
  process.exit(1);
});
