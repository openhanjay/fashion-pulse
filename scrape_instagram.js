/*
 * 인스타그램 경쟁사 계정(data/ig_accounts.json에 등록된 것들)의 최근 게시물을 Apify의
 * Instagram Scraper 액터로 수집해서 계정별 파일로 저장하는 스크립트.
 * 무신사/29CM 스크립트와 달리 순위 추이가 아니라 "최근 게시물 몇 개"만 필요해서,
 * 날짜/시간별로 계속 쌓지 않고 계정마다 파일 하나를 매번 덮어쓴다(계속 최신 상태만 유지).
 *
 * 인스타그램 CDN은 외부 사이트에서의 이미지 요청(핫링킹) 자체를 막아서, 원본 이미지 URL을
 * 그대로 대시보드에 넣으면 안 뜬다(실제 확인됨). 그래서 이미지를 직접 다운로드해서 이
 * 저장소 안에(data/instagram/images/{username}/...) 같이 저장하고, JSON에는 그 로컬
 * 경로를 넣는다. 계정 파일을 매번 통째로 덮어쓰는 것과 마찬가지로, 이미지 폴더도 실행마다
 * 그 계정 것만 통째로 비우고 새로 받아서 오래된 이미지가 저장소에 계속 쌓이지 않게 한다.
 *
 * 사용법:
 *   APIFY_TOKEN=xxx node scrape_instagram.js
 *
 * 실행할 때마다 계정마다:
 *   data/instagram/{username}.json
 *   data/instagram/images/{username}/*.jpg
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
const IG_IMAGES_DIR = path.join(IG_DATA_DIR, "images");

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

// 원격 이미지 URL을 받아 destPath에 저장한다. 실패하면 null(호출부에서 원본 필드를 그냥 비움).
async function downloadImage(url, destPath) {
  if (!url) return false;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch (err) {
    console.error(`이미지 다운로드 실패 (${url}):`, err.message);
    return false;
  }
}

// 계정 하나의 프로필 사진 + 게시물 썸네일들을 전부 다운로드해서 저장소 안 경로로 저장하고,
// profilePicUrl/각 post.displayUrl을 그 로컬 경로(repo 루트 기준 상대경로)로 바꿔치기한다.
// 다운로드에 실패한 건 그냥 빈 값으로 남겨서, 프론트가 이미 갖고 있는 "없으면 대체 아이콘" 로직을
// 그대로 타게 한다. 매번 그 계정 이미지 폴더를 통째로 비우고 새로 받아서 오래된 파일이 안 쌓인다.
async function localizeImages(username, profilePicUrl, posts) {
  const dir = path.join(IG_IMAGES_DIR, username);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const localProfilePicUrl = (await downloadImage(profilePicUrl, path.join(dir, "profile.jpg")))
    ? `data/instagram/images/${username}/profile.jpg`
    : "";

  const localPosts = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const ok = await downloadImage(post.displayUrl, path.join(dir, `post_${i}.jpg`));
    localPosts.push({ ...post, displayUrl: ok ? `data/instagram/images/${username}/post_${i}.jpg` : "" });
  }
  return { localProfilePicUrl, localPosts };
}

async function main() {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN 환경변수가 없어요.");
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log("등록된 인스타그램 계정이 없어요. data/ig_accounts.json을 확인하세요.");
    return;
  }
  if (!fs.existsSync(IG_DATA_DIR)) fs.mkdirSync(IG_DATA_DIR, { recursive: true });
  if (!fs.existsSync(IG_IMAGES_DIR)) fs.mkdirSync(IG_IMAGES_DIR, { recursive: true });

  const now = new Date();
  for (const account of accounts) {
    console.log(`수집 중: ${account.username} (${account.name}) ...`);
    try {
      const [posts, profilePicUrl] = await Promise.all([fetchPosts(account.url), fetchProfilePic(account.url)]);
      const { localProfilePicUrl, localPosts } = await localizeImages(account.username, profilePicUrl, posts);
      const result = {
        username: account.username,
        name: account.name,
        profilePicUrl: localProfilePicUrl,
        fetchedAt: kstTimestamp(now),
        posts: localPosts,
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
