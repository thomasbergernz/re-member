// eldaa-health-alert (module worker)
// Triggered by GitHub Actions cron (every 5 min) via POST /check with bearer auth.
// Pings both staging and prod /api/health endpoints, posts to Slack on failure.

const TARGETS = [
  { name: "staging", url: "https://eldaa.fly.dev/api/health" },
  { name: "production", url: "https://subscribe.eldaa.org.nz/api/health" },
];

function isAuthorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!env.CHECK_TOKEN) return false;
  return header === `Bearer ${env.CHECK_TOKEN}`;
}

async function check(target) {
  const start = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "eldaa-health-alert/1.0" },
    });
    const body = await res.json();
    return {
      name: target.name,
      url: target.url,
      ok: res.ok && body && body.status === "ok",
      httpStatus: res.status,
      body,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      name: target.name,
      url: target.url,
      ok: false,
      httpStatus: 0,
      body: null,
      latencyMs: Date.now() - start,
      error: String(err && err.message ? err.message : err),
    };
  }
}

function summarizeResult(r) {
  return {
    name: r.name,
    ok: r.ok,
    httpStatus: r.httpStatus,
    latencyMs: r.latencyMs,
    stripe: r.body && r.body.stripe,
    gmail: r.body && r.body.gmail,
    status: r.body && r.body.status,
    error: r.error,
  };
}

async function postSlack(webhook, results) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { sent: false, reason: "all_ok" };

  const headerText = `🚨 ELDAA health: ${failed.length}/${results.length} failing`;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: headerText } },
    ...failed.map((f) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${f.name}* — \`${f.url}\`\n` +
          `HTTP ${f.httpStatus} in ${f.latencyMs}ms` +
          (f.error ? `\nError: \`${f.error}\`` : "") +
          (f.body ? `\n\`\`\`json\n${JSON.stringify(f.body, null, 2)}\n\`\`\`` : ""),
      },
    })),
    { type: "context", elements: [{ type: "mrkdwn", text: `Checked at ${new Date().toISOString()}` }] },
  ];

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: headerText, blocks }),
  });

  const respText = await res.text();
  if (!res.ok) {
    return { sent: false, reason: "slack_error", httpStatus: res.status, slackResponse: respText };
  }
  return { sent: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "eldaa-health-alert\n\nPOST /check with Authorization: Bearer <CHECK_TOKEN>\n",
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    }

    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const results = await Promise.all(TARGETS.map(check));
    const slack = await postSlack(env.SLACK_WEBHOOK_URL, results);

    return new Response(
      JSON.stringify(
        {
          checked: results.length,
          failed: results.filter((r) => !r.ok).length,
          slack,
          results: results.map(summarizeResult),
        },
        null,
        2,
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
};
