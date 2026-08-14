/*
 * 인스타그램 경쟁사 계정(data/ig_accounts.json에 등록된 것들)의 최근 게시물을 Apify의
 * Instagram Scraper 액터로 수집해서 계정별 파일로 저장하는 스크립트.
 * 무신사/29CM 스크립트와 달리 순위 추이가 아니라 "최근 게시물 몇 개"만 필요해서,
 * 날짜/시간별로 계속 쌓지 않고 계정마다 파일 하나를 매번 덮어쓴다(계속 최신 상태만 유지).
 *
 * 사용법:
 *   APIFY_TOKEN=xxx node scrape_instagram.js
 *
 * 실행할 때마다 계정마다:
 *   data/instagram/{username}.json
 * 을 최신 내용으로 덮어쓴다. 대시보드는 data/ig_accounts.json(계정 목록)을 이미 갖고 있으니,
 * 그 목록의 username으로 이 파일들을 바로 찾아 불러온다(별도 인덱스 파일 불필요).
 *
 * Node 18 이상 (전역 fetch 사용) 필요.
 */

const fs = require("fs");
const path = require("path");

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR = "apify~instagram-scraper";
const APIFY_URL = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

const POSTS_PER_ACCOUNT = 8; // 계정당 가져올 최근 게시물 개수 (Apify 비용은 결과 개수 비례라 적게 유지)
const REQUEST_DELAY_MS = 2000; // 계정 사이 딜레이 (Apify 동시 실행 부하 방지)
const DATA_DIR = path.join(__dirname, "data");
const IG_ACCOUNTS_FILE = path.join(DATA_DIR, "ig_accounts.json");
const IG_DATA_DIR = path.join(DATA_DIR, "instagram");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 실행 서버의 로컬 타임존과 무관하게 항상 한국 시간(KST, UTC+9) 기준으로 계산 (GitHub Actions는 UTC라서 필요).
function toKst(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}
function kstTimestamp(now) {
  const k = toKst(now);
  return (
    `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())}` +
    `T${pad2(k.getUTCHours())}:${pad2(k.getUTCMinutes())}:${pad2(k.getUTCSeconds())}+09:00`
  );
}

function readAccounts() {
  if (!fs.existsSync(IG_ACCOUNTS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(IG_ACCOUNTS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function callApify(body) {
  const res = await fetch(APIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function mapPost(item) {
  return {
    url: item.url || "",
    type: item.type || "",
    displayUrl: item.displayUrl || "",
    caption: item.caption || "",
    likesCount: typeof item.likesCount === "number" ? item.likesCount : null,
    commentsCount: typeof item.commentsCount === "number" ? item.commentsCount : null,
    timestamp: item.timestamp || null,
  };
}

async function fetchPosts(accountUrl) {
  const items = await callApify({
    directUrls: [accountUrl],
    resultsType: "posts",
    resultsLimit: POSTS_PER_ACCOUNT,
  });
  return items.map(mapPost);
}

// 프로필 사진은 "posts" 모드 응답엔 안 들어있어서 "details" 모드로 계정당 한 번 더(가볍게) 조회한다.
// 액터 응답 형태가 문서화된 것과 다르거나 실패해도 전체 수집은 계속 진행되게 실패를 흡수한다
// (대시보드는 profilePicUrl이 없으면 기존 이니셜 아이콘으로 대체 표시함).
async function fetchProfilePic(accountUrl) {
  try {
    const items = await callApify({ directUrls: [accountUrl], resultsType: "details", resultsLimit: 1 });
    const info = items[0];
    return info?.profilePicUrlHD || info?.profilePicUrl || null;
  } catch (err) {
    console.error(`프로필 사진 조회 실패 (${accountUrl}):`, err.message);
    return null;
  }
}

async function main() {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN 환경변수가 없어요.");
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log("등록된 인스타그램 계정이 없어요. data/ig_accounts.json을 확인하세요.");
    return;
  }
  if (!fs.existsSync(IG_DATA_DIR)) fs.mkdirSync(IG_DATA_DIR, { recursive: true });

  const now = new Date();
  for (const account of accounts) {
    console.log(`수집 중: ${account.username} (${account.name}) ...`);
    try {
      const [posts, profilePicUrl] = await Promise.all([fetchPosts(account.url), fetchProfilePic(account.url)]);
      const result = {
        username: account.username,
        name: account.name,
        profilePicUrl,
        fetchedAt: kstTimestamp(now),
        posts,
      };
      fs.writeFileSync(path.join(IG_DATA_DIR, `${account.username}.json`), JSON.stringify(result, null, 2), "utf-8");
      console.log(`완료: ${account.username} (게시물 ${posts.length}개)`);
    } catch (err) {
      console.error(`수집 실패 (${account.username}):`, err.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

main().catch((err) => {
  console.error("스크래핑 실패:", err);
  process.exit(1);
});
