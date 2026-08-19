/*
 * 대시보드의 "지금 스크랩하기" 버튼이 호출하는 작은 중계 서버 (Cloudflare Worker).
 * GitHub Actions workflow_dispatch를 대신 호출해준다. GitHub 토큰은 여기(서버 쪽, env.GITHUB_TOKEN)에만
 * 있고 클라이언트(대시보드)에는 절대 노출되지 않는다.
 *
 * 아무나 계속 눌러서 도배하지 못하도록, KV에 짧은 TTL로 "최근 실행됨" 표시를 남겨
 * 쿨다운(1시간) 동안은 재요청을 막는다.
 *
 * 08:00/13:00/18:00/23:00 KST 자동 스크랩도 (GitHub Actions 자체 cron 대신) 이 Worker의 Cron Trigger가 맡는다.
 * GitHub Actions의 예약 실행은 부하가 많을 때 몇십 분씩 늦어질 수 있는데, Cloudflare Cron Trigger가
 * 훨씬 시각을 잘 지키기 때문. wrangler.toml의 [triggers] crons 참고.
 *
 * /instagram-accounts 경로는 인스타그램 모니터링 브랜드 목록(data/ig_accounts.json)을,
 * /watch-lists 경로는 무신사/29CM의 관심 브랜드·검색어 목록(data/musinsa_brand_watch.json,
 * data/cm29_brand_watch.json)을 GitHub Contents API로 직접 커밋해준다. 이렇게 저장소 파일에
 * 직접 반영해야 localStorage와 달리 다른 기기/브라우저에서 들어가도 같은 목록이 보인다.
 */

const OWNER = "openhanjay";
const REPO = "fashion-pulse";
const WORKFLOW_FILE = "scrape.yml";
const INSTAGRAM_WORKFLOW_FILE = "scrape_instagram.yml";
const IG_ACCOUNTS_PATH = "data/ig_accounts.json";
const WATCH_LIST_PATHS = {
  musinsa: "data/musinsa_brand_watch.json",
  cm29: "data/cm29_brand_watch.json",
};
const ALLOWED_ORIGIN = "https://openhanjay.github.io";
const COOLDOWN_SECONDS = 3600;
const INSTAGRAM_COOLDOWN_SECONDS = 300; // 브랜드 추가/수정마다 매번 전체 계정을 다시 스크랩하니, 짧게라도 도배 방지

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
  });
}

// GitHub Contents API는 UTF-8 바이트를 base64로 담는데, atob/btoa는 Latin1 기준이라
// 한글 같은 멀티바이트 문자를 그대로 넣으면 깨진다. escape/unescape로 퍼센트 인코딩을
// 한 번 거쳐서 안전하게 변환한다.
function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(escape(atob(str)));
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fashion-pulse-scrape-trigger",
    "Content-Type": "application/json",
  };
}

async function dispatchWorkflow(env, workflowFile = WORKFLOW_FILE) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: ghHeaders(env),
    body: JSON.stringify({ ref: "main" }),
  });
}

// 브랜드 추가/수정 시 다음날 예약 실행을 기다리지 않고 바로 인스타 스크랩을 돌려준다.
// 계정 하나만 새로 긁는 게 아니라 목록 전체를 다시 스크랩하는 구조라, 짧은 쿨다운으로
// 연속 추가 시 매번 트리거되는 걸 막는다. 저장 자체(계정 목록 커밋)는 이 트리거 성패와 무관하게
// 이미 끝난 뒤라, 실패해도 조용히 무시한다(다음날 예약 실행이 어차피 한 번 더 돈다).
async function triggerInstagramScrape(env) {
  try {
    const cooling = await env.RATE_LIMIT_KV.get("lastInstagramTriggeredAt");
    if (cooling) return;
    const res = await dispatchWorkflow(env, INSTAGRAM_WORKFLOW_FILE);
    if (res.status === 204) {
      await env.RATE_LIMIT_KV.put("lastInstagramTriggeredAt", String(Date.now()), { expirationTtl: INSTAGRAM_COOLDOWN_SECONDS });
    }
  } catch (err) {
    console.error("instagram scrape trigger failed:", err);
  }
}

// filePath의 현재 내용(JSON 배열)과 sha를 읽어온다. 파일이 아직 없으면(404) 빈 배열 + sha 없음으로 취급.
async function readJsonArrayFile(env, filePath) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`, {
    headers: ghHeaders(env),
  });
  if (res.status === 404) return { list: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const data = await res.json();
  const list = JSON.parse(b64DecodeUnicode(data.content.replace(/\n/g, "")));
  return { list: Array.isArray(list) ? list : [], sha: data.sha };
}

async function putJsonArrayFile(env, filePath, list, sha, message) {
  const body = { message, content: b64EncodeUnicode(JSON.stringify(list, null, 2)), ...(sha ? { sha } : {}) };
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body),
  });
}

// 새 배열을 커밋한다. sha가 어긋나서 409가 나면(동시 수정 충돌) 최신 sha로 한 번만 재시도.
async function writeJsonArrayFile(env, filePath, list, sha, message) {
  let res = await putJsonArrayFile(env, filePath, list, sha, message);
  if (res.status === 409) {
    const latest = await readJsonArrayFile(env, filePath);
    res = await putJsonArrayFile(env, filePath, list, latest.sha, message);
  }
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function readIgAccounts(env) {
  const { list, sha } = await readJsonArrayFile(env, IG_ACCOUNTS_PATH);
  return { accounts: list, sha };
}
function writeIgAccounts(env, accounts, sha, message) {
  return writeJsonArrayFile(env, IG_ACCOUNTS_PATH, accounts, sha, message);
}

async function handleWatchList(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "잘못된 요청이에요." }, 400);
  }
  const { list, action, value } = payload || {};
  const filePath = WATCH_LIST_PATHS[list];
  if (!filePath) return json({ ok: false, message: "알 수 없는 목록이에요." }, 400);
  if (!["add", "remove"].includes(action) || !value) return json({ ok: false, message: "잘못된 요청이에요." }, 400);

  try {
    const { list: current, sha } = await readJsonArrayFile(env, filePath);
    const next = action === "add"
      ? (current.includes(value) ? current : [...current, value])
      : current.filter((v) => v !== value);
    const message = `chore: ${list} 관심 브랜드/검색어 ${action === "add" ? "추가" : "삭제"} (${value})`;
    await writeJsonArrayFile(env, filePath, next, sha, message);
    return json({ ok: true, list: next });
  } catch (err) {
    return json({ ok: false, message: "저장소에 반영하지 못했어요.", detail: String(err) }, 502);
  }
}

async function handleIgAccounts(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "잘못된 요청이에요." }, 400);
  }
  const { action, account, id } = payload || {};
  if (!["add", "edit", "remove"].includes(action)) {
    return json({ ok: false, message: "알 수 없는 동작이에요." }, 400);
  }

  try {
    const { accounts, sha } = await readIgAccounts(env);
    let nextAccounts = accounts;
    let message;

    if (action === "add") {
      if (!account || !account.username) return json({ ok: false, message: "계정 정보가 없어요." }, 400);
      const newAccount = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: account.name || "", username: account.username, url: account.url || "" };
      nextAccounts = [...accounts, newAccount];
      message = `chore: 인스타 계정 추가 (${newAccount.username})`;
    } else if (action === "edit") {
      if (!account || !account.id) return json({ ok: false, message: "계정 정보가 없어요." }, 400);
      nextAccounts = accounts.map((a) => (a.id === account.id ? { ...a, name: account.name ?? a.name, username: account.username ?? a.username, url: account.url ?? a.url } : a));
      message = `chore: 인스타 계정 수정 (${account.username || account.id})`;
    } else if (action === "remove") {
      if (!id) return json({ ok: false, message: "계정 id가 없어요." }, 400);
      nextAccounts = accounts.filter((a) => a.id !== id);
      message = `chore: 인스타 계정 삭제 (${id})`;
    }

    await writeIgAccounts(env, nextAccounts, sha, message);
    if (action === "add" || action === "edit") await triggerInstagramScrape(env);
    return json({ ok: true, accounts: nextAccounts });
  } catch (err) {
    return json({ ok: false, message: "저장소에 반영하지 못했어요.", detail: String(err) }, 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (request.method !== "POST") return json({ ok: false, message: "허용되지 않은 메서드예요." }, 405);

    const url = new URL(request.url);
    if (url.pathname === "/instagram-accounts") return handleIgAccounts(request, env);
    if (url.pathname === "/watch-lists") return handleWatchList(request, env);

    const cooling = await env.RATE_LIMIT_KV.get("lastTriggeredAt");
    if (cooling) {
      return json({ ok: false, message: `방금 실행됐어요. ${COOLDOWN_SECONDS / 60}분 정도 뒤에 다시 시도해주세요.` }, 429);
    }

    const ghRes = await dispatchWorkflow(env);

    if (ghRes.status === 204) {
      await env.RATE_LIMIT_KV.put("lastTriggeredAt", String(Date.now()), { expirationTtl: COOLDOWN_SECONDS });
      return json({ ok: true, message: "스크랩을 시작했어요! 1~2분 후 랭킹이 갱신돼요." });
    }

    const detail = await ghRes.text();
    return json({ ok: false, message: "요청이 실패했어요.", detail }, 502);
  },

  // 08:00 / 13:00 / 18:00 / 23:00 KST 예약 실행 (wrangler.toml [triggers] crons 참고). 쿨다운 여부와 무관하게 항상 실행하고,
  // 성공하면 쿨다운 락을 남겨서 직후의 수동 버튼 클릭으로 인한 중복 스크랩을 막는다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatchWorkflow(env).then((res) => {
        if (res.status === 204) {
          return env.RATE_LIMIT_KV.put("lastTriggeredAt", String(Date.now()), { expirationTtl: COOLDOWN_SECONDS });
        }
        return res.text().then((detail) => console.error("scheduled dispatch failed:", res.status, detail));
      })
    );
  },
};
