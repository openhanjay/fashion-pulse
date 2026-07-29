/*
 * 29CM 베스트 랭킹(여성의류/남성의류 x 서브카테고리 x 실시간/일간/주간/월간)을 수집해서
 * 날짜+시간별 파일로 저장하는 스크립트. scrape_musinsa.js와 동일한 방식(직전 수집 대비 순위 변동,
 * 날짜/시간별 파일+인덱스)으로 동작한다.
 *
 * 사용법:
 *   node scrape_cm29.js
 *
 * 실행할 때마다:
 *   data/cm29_YYYY-MM-DD_HH-mm.json   (그 시점 수집한 랭킹 데이터, 직전 수집 대비 순위 변동 포함)
 *   data/cm29_index.json              (날짜 -> 수집 시간 목록 매핑, 자동 누적/갱신)
 * 을 만들거나 갱신한다.
 *
 * 저장 구조: { [대분류]: { [서브카테고리]: { [기간]: [상품...] } } }
 *   대분류: 여성의류, 남성의류
 *   기간: 실시간(HOURLY), 일간(DAILY), 주간(WEEKLY), 월간(MONTHLY)
 *
 * Node 18 이상 (전역 fetch 사용) 필요.
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://display-bff-api.29cm.co.kr/api/v1/plp/best/items";

const HEADERS = {
  accept: "*/*",
  "content-type": "application/json",
  origin: "https://www.29cm.co.kr",
  referer: "https://www.29cm.co.kr/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

// 대분류 + 서브카테고리 코드 (largeId/middleId, 실제 29CM 데이터에서 확인한 값). 전체 = middleId 없음.
// "가방"은 29CM에서는 여성의류/남성의류와 같은 급의 별도 대분류(여성가방=269100100, 남성가방=273100100)라서,
// 서브카테고리 값에 { largeId, middleId }를 넣어 부모 대분류가 아닌 이 대분류로 조회하도록 오버라이드한다.
const CM29_CATEGORIES = {
  여성의류: {
    largeId: 268100100,
    subs: {
      전체: null,
      상의: 268103100,
      아우터: 268102100,
      바지: 268106100,
      스커트: 268107100,
      원피스: 268104100,
      니트웨어: 268105100,
      셋업: 268117100,
      홈웨어: 268110100,
      가방: { largeId: 269100100, middleId: null },
    },
  },
  남성의류: {
    largeId: 272100100,
    subs: {
      전체: null,
      상의: 272103100,
      아우터: 272102100,
      하의: 272104100,
      니트웨어: 272110100,
      셋업: 272112100,
      이너웨어: 272105100,
      홈웨어: 272113100,
      가방: { largeId: 273100100, middleId: null },
    },
  },
};

// 기간(랭킹 필터) <-> 29CM periodFacetInput.type
const PERIOD_TYPES = {
  실시간: "HOURLY",
  일간: "DAILY",
  주간: "WEEKLY",
  월간: "MONTHLY",
};

const TOP_N = 100; // 한 번에 최대 100개까지만 주는 API라 100으로 고정 (더 깊게 가려면 page 페이지네이션 필요)
const REQUEST_DELAY_MS = 500;
const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(DATA_DIR, "cm29_index.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 실행 서버의 로컬 타임존과 무관하게 항상 한국 시간(KST, UTC+9) 기준으로 날짜/시각을 계산한다.
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

function mapItem(item, rank) {
  const info = item.itemInfo || {};
  const badge = (info.textBadges && info.textBadges[0]?.text) || (info.imageBadges && info.imageBadges[0]?.text) || null;
  return {
    rank,
    brand: info.brandName || "",
    name: info.productName || "",
    price: info.displayPrice ?? info.sellPrice ?? 0,
    discountRatio: Math.round(info.saleRate || 0),
    image: info.thumbnailUrl || "",
    url: item.itemUrl?.webLink || "",
    badge,
  };
}

async function fetchRanking(largeId, middleId, periodType) {
  const categoryFacetInputs = [middleId ? { largeId, middleId } : { largeId }];
  const body = {
    pageRequest: { page: 1, size: TOP_N },
    userSegment: { gender: "F", age: "THIRTIES" },
    facets: {
      categoryFacetInputs,
      periodFacetInput: { type: periodType, order: "DESC" },
      rankingFacetInput: { type: "POPULARITY" },
    },
  };
  const res = await fetch(API_URL, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} (largeId=${largeId}, middleId=${middleId}, period=${periodType})`);
  const payload = await res.json();
  const list = payload?.data?.list || [];
  return list.map((item, i) => mapItem(item, i + 1));
}

const POPULAR_KEYWORD_URL = "https://search-api.29cm.co.kr/api/v4/keyword/popular";

// 29CM은 검색어 랭킹(순위 변동 포함)은 따로 없고, 인기 검색어 TOP 10 리스트만 제공한다.
async function fetchPopularKeywords() {
  const res = await fetch(POPULAR_KEYWORD_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} (popular keywords)`);
  const payload = await res.json();
  return payload?.data?.popularKeyword || [];
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

// 지금 막 수집한 것 바로 이전의 스냅샷을 찾는다 (scrape_musinsa.js와 동일한 규칙).
function findLatestPriorSnapshot(index, dateStr, timeStr) {
  const sameDayEarlier = (index[dateStr] || []).filter((t) => t < timeStr).sort();
  if (sameDayEarlier.length) return { date: dateStr, time: sameDayEarlier[sameDayEarlier.length - 1] };
  const priorDates = Object.keys(index).filter((d) => d < dateStr).sort();
  const priorDate = priorDates[priorDates.length - 1];
  if (!priorDate) return null;
  const priorTimes = index[priorDate] || [];
  if (!priorTimes.length) return null;
  return { date: priorDate, time: priorTimes[priorTimes.length - 1] };
}

function loadSnapshotFile(dateStr, timeStr) {
  const file = path.join(DATA_DIR, `cm29_${dateStr}_${timeStr}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// 이전 스냅샷과 상품 URL 기준으로 매칭해서 순위 변동(delta)을 매긴다.
function attachDeltas(today, prior) {
  if (!prior) return today;
  Object.keys(today).forEach((largeCat) => {
    Object.keys(today[largeCat]).forEach((subCat) => {
      Object.keys(today[largeCat][subCat]).forEach((periodKey) => {
        const priorList = prior?.[largeCat]?.[subCat]?.[periodKey] || [];
        const priorRankByUrl = new Map(priorList.filter((it) => it.url).map((it) => [it.url, it.rank]));
        today[largeCat][subCat][periodKey] = today[largeCat][subCat][periodKey].map((item) => {
          if (!item.url || !priorRankByUrl.has(item.url)) return { ...item, delta: "NEW" };
          return { ...item, delta: priorRankByUrl.get(item.url) - item.rank };
        });
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
  const priorSnap = findLatestPriorSnapshot(indexBefore, dateStr, timeStr);
  const priorSnapshot = priorSnap ? loadSnapshotFile(priorSnap.date, priorSnap.time) : null;
  console.log(priorSnap ? `비교 기준(직전 수집): ${priorSnap.date} ${priorSnap.time}` : "이전 수집 데이터 없음 (순위 변동 표시 없이 저장)");

  const result = {};
  for (const [largeCat, { largeId, subs }] of Object.entries(CM29_CATEGORIES)) {
    result[largeCat] = {};
    for (const [subCat, subConfig] of Object.entries(subs)) {
      // subConfig가 { largeId, middleId } 객체면 부모 대분류가 아닌 그 대분류로 조회 (가방 등)
      const isOverride = subConfig && typeof subConfig === "object";
      const effectiveLargeId = isOverride ? subConfig.largeId : largeId;
      const effectiveMiddleId = isOverride ? subConfig.middleId : subConfig;
      result[largeCat][subCat] = {};
      for (const [periodLabel, periodType] of Object.entries(PERIOD_TYPES)) {
        console.log(`수집 중: ${largeCat} / ${subCat} / ${periodLabel} ...`);
        result[largeCat][subCat][periodLabel] = await fetchRanking(effectiveLargeId, effectiveMiddleId, periodType);
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  attachDeltas(result, priorSnapshot);

  console.log("수집 중: 인기 검색어 ...");
  result.popularKeywords = await fetchPopularKeywords();

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const outFile = path.join(DATA_DIR, `cm29_${dateStr}_${timeStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
  const index = updateIndex(dateStr, timeStr);

  console.log(`완료: data/cm29_${dateStr}_${timeStr}.json 저장됨 (TOP ${TOP_N})`);
  console.log(`${dateStr} 누적 수집 시각: ${index[dateStr].join(", ")}`);
}

main().catch((err) => {
  console.error("스크래핑 실패:", err);
  process.exit(1);
});
