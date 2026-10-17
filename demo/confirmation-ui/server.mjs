// Local SYNTHETIC DEMO only. No env secrets, production URLs, DB or network
// clients. Fake personas are freely selectable and establish NO real identity.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createTaskProposalHandler } from "../../supabase/functions/_shared/task-proposal-runtime.js";
import { ProposalError } from "../../supabase/functions/_shared/proposal-execution-scope.js";
import { syntheticMemoryStore } from "./memory-store.mjs";
import { syntheticReviewSource, SYNTHETIC_AUTHORITY } from "./review-source.mjs";

const personas = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222" };
const json = (body, status = 200) => Response.json({ synthetic_demo: true, real_human_provenance: false, real_task_writes: 0, ...body }, { status });
export async function startSyntheticConfirmationDemo({ port = 0, clock = () => new Date(), ttlSeconds = 600 } = {}) {
  const store = syntheticMemoryStore(clock), source = syntheticReviewSource({ store, clock });
  const sessions = new Map(), simulated = new Map(); let baseURL;
  const page = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("./page.js", import.meta.url), "utf8");
  const execute = async (input, key) => {
    if (simulated.has(key)) return structuredClone(simulated.get(key));
    const id = `synthetic-task-${simulated.size + 1}`, requestId = crypto.randomUUID();
    const receipt = { success: true, write_success: true, verified: true, id, request_id: requestId,
      receipt: { task_id: id, request_id: requestId, task_save_status: "verified", reminder_projection_status: "not_requested" } };
    simulated.set(key, { ...receipt, ownerId: input.proposal_guard.owner_id, title: input.title, key });
    return receipt;
  };
  const handlerFor = session => createTaskProposalHandler({ store, clock, ttlSeconds,
    authenticateUser: async () => ({ ownerId: session.ownerId }), resolveAccount: async () => session.accountSubject,
    verifyReplySource: source.verifyReplySource, trustedAuthorities: [SYNTHETIC_AUTHORITY], resolveContext: async () => ({}), sendIntake: execute });
  const server = createServer(async (incoming, outgoing) => {
    let response;
    try {
      if (incoming.headers.host !== new URL(baseURL).host) throw new ProposalError("LOOPBACK_HOST_REQUIRED", 403);
      const url = new URL(incoming.url, baseURL), method = incoming.method;
      const cookie = incoming.headers.cookie?.match(/(?:^|;\s*)synthetic_demo_session=([^;]+)/)?.[1];
      const session = sessions.get(cookie);
      if (!["GET", "POST"].includes(method)) throw new ProposalError("METHOD_NOT_ALLOWED", 405);
      let text = "";
      if (method === "POST") {
        if (incoming.headers.origin !== baseURL || !incoming.headers["content-type"]?.startsWith("application/json")) throw new ProposalError("SAME_ORIGIN_JSON_REQUIRED", 403);
        if (url.pathname !== "/demo/session" && (!session || incoming.headers["x-demo-csrf"] !== session.csrf)) throw new ProposalError("DEMO_SESSION_OR_CSRF_REQUIRED", 403);
        let bytes = 0; const chunks = [];
        for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 16384) throw new ProposalError("REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
        text = Buffer.concat(chunks).toString("utf8");
      }
      const body = () => { try { return JSON.parse(text); } catch { throw new ProposalError("INVALID_JSON", 400); } };
      const request = () => new Request(url, { method, headers: incoming.headers, ...(method === "POST" ? { body: text } : {}) });
      if (method === "GET" && url.pathname === "/") response = new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      else if (method === "GET" && url.pathname === "/page.js") response = new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      else if (method === "POST" && url.pathname === "/demo/session") {
        const input = body();
        if (!input || Object.keys(input).join(",") !== "persona" || !personas[input.persona]) throw new ProposalError("FAKE_PERSONA_REQUIRED", 400);
        const id = crypto.randomUUID(), ownerId = personas[input.persona];
        const fake = { ownerId, accountSubject: `synthetic-google:${ownerId}`, csrf: crypto.randomUUID(), persona: input.persona };
        sessions.set(id, fake); response = json({ persona: fake.persona, csrf: fake.csrf });
        response.headers.set("Set-Cookie", `synthetic_demo_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
      } else if (!session) throw new ProposalError("FAKE_PERSONA_REQUIRED", 401);
      else if (method === "GET" && url.pathname === "/demo/state") response = json({ persona: session.persona,
        simulated_execution_count: [...simulated.values()].filter(x => x.ownerId === session.ownerId).length, events: source.summary(session) });
      else if (url.pathname.startsWith("/demo/proposals")) response = await handlerFor(session)(request());
      else if (method === "GET" && /^\/demo\/preview\/[0-9a-f-]{36}$/.test(url.pathname)) {
        const id = url.pathname.split("/").pop(), row = await store.get(id, session);
        if (!row) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
        const preview = await handlerFor(session)(new Request(`${baseURL}/demo/proposals/${id}`));
        response = json({ preview: await preview.json(), challenge_id: ["pending", "claimed"].includes(row.status) ? source.challenge(row) : null });
      } else if (method === "POST" && url.pathname === "/demo/review") {
        const event = await source.record(body(), session);
        let closure = null;
        if (event.disposition !== "approve_exact") {
          const stop = await handlerFor(session)(new Request(`${baseURL}/demo/proposals/${event.proposalId}/confirm`, { method: "POST", body: JSON.stringify({ version: event.version, scope_digest: event.scopeDigest, reply_event_id: event.eventId }) }));
          closure = await stop.json();
        }
        response = json({ event_id: event.eventId, decision: event.disposition, closure });
      } else response = json({ code: "NOT_FOUND" }, 404);
    } catch (error) { response = json({ success: false, code: error instanceof ProposalError ? error.code : "SYNTHETIC_DEMO_ERROR" }, error instanceof ProposalError ? error.status : 500); }
    const headers = Object.fromEntries(response.headers);
    Object.assign(headers, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Personal-OS-Mode": "synthetic-demo",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" });
    outgoing.writeHead(response.status, headers); outgoing.end(await response.text());
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  return { baseURL, close: () => new Promise(resolve => server.close(resolve)) };
}
