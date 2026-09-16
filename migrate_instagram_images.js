/*
 * 일회성 마이그레이션: 기존 인스타 데이터를 새 구조로 옮긴다.
 *
 * 바뀌는 것 두 가지.
 *  1) 이미지 파일명을 순번(post_0.jpg)에서 게시물 ID(DdQVB1flEF2.jpg)로. 순번으로 두면
 *     피드가 한 칸 밀릴 때마다 같은 사진이 다른 이름으로 다시 저장된다.
 *  2) 원본 해상도(최대 3276x4096, 3MB대)를 400px로 축소. 대시보드는 150px 남짓 썸네일로
 *     쓰는데 원본을 담고 있어서 저장소가 수집마다 3MB씩 늘고 있었다(실측 182배 차이).
 * 덤으로 지금 피드에 있는 게시물을 히스토리 첫 기록으로 넣어서, 다음 수집을 기다리지 않아도
 * "과거 피드" 화면이 바로 동작하게 한다.
 *
 * Apify를 호출하지 않는다 - 이미 받아둔 로컬 파일만 다룬다.
 *
 * 사용법: node migrate_instagram_images.js [--dry]
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const DATA_DIR = path.join(__dirname, "data");
const IG_DATA_DIR = path.join(DATA_DIR, "instagram");
const IG_IMAGES_DIR = path.join(IG_DATA_DIR, "images");
const IG_HISTORY_DIR = path.join(IG_DATA_DIR, "history");

const IMAGE_MAX_PX = 400;
const IMAGE_QUALITY = 72;

function postIdOf(url) {
  const m = String(url || "").match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function shrink(file) {
  // sharp에 경로를 넘기면 파일 핸들을 쥔 채로 작업해서, 같은 경로에 덮어쓸 때 윈도우에서
  // 잠금 충돌이 난다(profile.jpg에서 실제로 발생). 먼저 버퍼로 읽어 핸들을 닫고 처리한다.
  const input = fs.readFileSync(file);
  const buf = await sharp(input)
    .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: IMAGE_QUALITY })
    .toBuffer();
  return { buf, before: input.length, after: buf.length };
}

async function run() {
  const dry = process.argv.includes("--dry");
  if (!fs.existsSync(IG_DATA_DIR)) { console.log("인스타 데이터가 없어요."); return; }
  if (!dry) fs.mkdirSync(IG_HISTORY_DIR, { recursive: true });

  const files = fs.readdirSync(IG_DATA_DIR).filter((f) => f.endsWith(".json"));
  let totalBefore = 0, totalAfter = 0, renamed = 0, shrunk = 0;

  for (const f of files) {
    const username = f.slice(0, -".json".length);
    const snap = JSON.parse(fs.readFileSync(path.join(IG_DATA_DIR, f), "utf8"));
    const dir = path.join(IG_IMAGES_DIR, username);
    if (!fs.existsSync(dir)) continue;

    const day = (snap.fetchedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const store = {};
    const nextPosts = [];

    for (const post of snap.posts || []) {
      const id = postIdOf(post.url);
      if (!id) { nextPosts.push(post); continue; }
      const oldAbs = post.displayUrl ? path.join(__dirname, post.displayUrl) : null;
      const newRel = `data/instagram/images/${username}/${id}.jpg`;
      const newAbs = path.join(dir, `${id}.jpg`);

      if (oldAbs && fs.existsSync(oldAbs)) {
        const { buf, before, after } = await shrink(oldAbs);
        totalBefore += before; totalAfter += after; shrunk += 1;
        if (!dry) {
          fs.writeFileSync(newAbs, buf);
          if (path.resolve(oldAbs) !== path.resolve(newAbs)) { fs.rmSync(oldAbs, { force: true }); renamed += 1; }
        }
      }
      const withId = { ...post, id, displayUrl: fs.existsSync(newAbs) || dry ? newRel : "" };
      nextPosts.push(withId);
      store[id] = {
        ...withId,
        firstSeen: day,
        lastSeen: day,
        metrics: [{ d: day, l: post.likesCount ?? null, c: post.commentsCount ?? null, v: post.videoPlayCount ?? null }],
      };
    }

    // 프로필 사진도 같이 줄인다
    const profAbs = path.join(dir, "profile.jpg");
    if (fs.existsSync(profAbs)) {
      const { buf, before, after } = await shrink(profAbs);
      totalBefore += before; totalAfter += after; shrunk += 1;
      if (!dry) fs.writeFileSync(profAbs, buf);
    }

    if (!dry) {
      snap.posts = nextPosts;
      fs.writeFileSync(path.join(IG_DATA_DIR, f), JSON.stringify(snap, null, 2), "utf-8");
      const ids = Object.keys(store).sort();
      const lines = ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(store[id])}`);
      fs.writeFileSync(
        path.join(IG_HISTORY_DIR, `${username}.json`),
        `{\n "username": ${JSON.stringify(username)},\n "updatedAt": ${JSON.stringify(day)},\n "posts": {\n${lines.join(",\n")}\n }\n}\n`,
        "utf-8"
      );
    }
    console.log(`  ${username}: 게시물 ${nextPosts.length}개 처리`);
  }

  console.log(`\n${dry ? "[모의 실행] " : ""}이미지 ${shrunk}장 축소, ${renamed}장 이름 변경`);
  console.log(`용량 ${(totalBefore / 1048576).toFixed(1)}MB -> ${(totalAfter / 1048576).toFixed(1)}MB` +
    (totalAfter ? ` (${(totalBefore / totalAfter).toFixed(0)}배 감소)` : ""));
}

run().catch((e) => { console.error("실패:", e); process.exit(1); });
