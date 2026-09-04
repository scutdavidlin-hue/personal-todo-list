import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.0";
import { TaskCloudClient } from "../../src/cloud-client.js";

const config = window.TASK_SYNC_CONFIG || {};
const cloud = new TaskCloudClient(config);
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const authorizationId = new URLSearchParams(location.search).get("authorization_id") || "";

const elements = {
  title: document.querySelector("#title"),
  message: document.querySelector("#message"),
  details: document.querySelector("#details"),
  actions: document.querySelector("#actions"),
  clientName: document.querySelector("#clientName"),
  scopes: document.querySelector("#scopes"),
  account: document.querySelector("#account"),
  approve: document.querySelector("#approveButton"),
  deny: document.querySelector("#denyButton"),
  login: document.querySelector("#loginButton"),
  error: document.querySelector("#error"),
};

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
  elements.title.textContent = "暂时无法完成授权";
  elements.message.textContent = "你的任务数据没有被分享或修改。";
}

async function attachSession() {
  cloud.consumeAuthRedirect();
  const session = cloud.session();
  if (!session?.access_token || !session?.refresh_token) return null;
  const result = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (result.error) throw result.error;
  try { await cloud.finalizeGoogleTasksConnection(); } catch { /* Existing connection remains usable. */ }
  return result.data.user || result.data.session?.user || null;
}

async function decide(action) {
  elements.approve.disabled = true;
  elements.deny.disabled = true;
  const operation = action === "approve"
    ? supabase.auth.oauth.approveAuthorization(authorizationId)
    : supabase.auth.oauth.denyAuthorization(authorizationId);
  const { data, error } = await operation;
  if (error) {
    elements.approve.disabled = false;
    elements.deny.disabled = false;
    showError(error.message);
    return;
  }
  location.assign(data.redirect_url);
}

elements.login.addEventListener("click", () => cloud.requestGoogleLogin(location.href));
elements.approve.addEventListener("click", () => decide("approve"));
elements.deny.addEventListener("click", () => decide("deny"));

async function start() {
  if (!cloud.isConfigured()) throw new Error("Personal OS public configuration is incomplete");
  if (!authorizationId) throw new Error("缺少 authorization_id，请从 ChatGPT 连接流程重新打开此页面");
  const user = await attachSession();
  if (!user) {
    elements.title.textContent = "登录后继续授权";
    elements.message.textContent = "请使用已连接 Personal OS 的 Google 账号登录。";
    elements.login.hidden = false;
    return;
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) throw error;
  elements.title.textContent = `允许 ${data.client?.name || "ChatGPT"} 连接 Personal OS？`;
  elements.message.textContent = "允许后，ChatGPT 可以把你明确确认的普通待办真实写入 Google Tasks。";
  elements.clientName.textContent = data.client?.name || data.client?.id || "ChatGPT";
  elements.scopes.textContent = data.scope || "email";
  elements.account.textContent = data.user?.email || user.email || "当前账号";
  elements.details.hidden = false;
  elements.actions.hidden = false;
}

start().catch((error) => showError(error instanceof Error ? error.message : "未知错误"));
