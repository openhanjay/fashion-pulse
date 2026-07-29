/*
 * 대시보드의 "지금 스크랩하기" 버튼이 호출하는 작은 중계 서버 (Cloudflare Worker).
 * GitHub Actions workflow_dispatch를 대신 호출해준다. GitHub 토큰은 여기(서버 쪽, env.GITHUB_TOKEN)에만
 * 있고 클라이언트(대시보드)에는 절대 노출되지 않는다.
 *
 * 아무나 계속 눌러서 도배하지 못하도록, KV에 짧은 TTL로 "최근 실행됨" 표시를 남겨
 * 쿨다운(1시간) 동안은 재요청을 막는다.
 *
 * 08:00/17:00 KST 자동 스크랩도 (GitHub Actions 자체 cron 대신) 이 Worker의 Cron Trigger가 맡는다.
 * GitHub Actions의 예약 실행은 부하가 많을 때 몇십 분씩 늦어질 수 있는데, Cloudflare Cron Trigger가
 * 훨씬 시각을 잘 지키기 때문. wrangler.toml의 [triggers] crons 참고.
 */

const OWNER = "openhanjay";
const REPO = "fashion-pulse";
const WORKFLOW_FILE = "scrape.yml";
const ALLOWED_ORIGIN = "https://openhanjay.github.io";
const COOLDOWN_SECONDS = 3600;

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

async function dispatchWorkflow(env) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fashion-pulse-scrape-trigger",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (request.method !== "POST") return json({ ok: false, message: "허용되지 않은 메서드예요." }, 405);

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

  // 08:00 / 17:00 KST 예약 실행 (wrangler.toml [triggers] crons 참고). 쿨다운 여부와 무관하게 항상 실행하고,
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
