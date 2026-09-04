const CLOSED_STATUSES = new Set(["Completed", "Dropped", "Archived"]);

const DOMAIN_PATTERNS = Object.freeze({
  personal_os_product: /(?:personal\s*os|to\s*c|mvp|产品化|商业化|用户测试|内测)/i,
  finance_role: /(?:财务岗位|财务人员|财务团队|经营化|项目落地|客户财务|销售拓展|销售任务|提成|薪酬分摊|财务.{0,40}(?:岗位|销售|项目|提成|薪酬|开发))/i,
  business_growth: /(?:业务|客户|销售|项目|商业|公司|创业|营收|获客|增长)/i,
  career: /(?:岗位|职业|工作|升职|转型|能力|团队|员工)/i,
  money: /(?:财务|预算|应收|应付|欠款|利润|成本|收入|薪酬|工资|分配|投资|储蓄)/i,
  property: /(?:买房|购房|住房|房产|楼盘|首付|户型)/i,
  family: /(?:家庭|孩子|父母|家人|老婆|丈夫|妻子)/i,
  health: /(?:健康|运动|体检|睡眠|医疗|康复)/i,
  learning: /(?:学习|课程|读书|考试|培训)/i,
  travel: /(?:旅行|旅游|行程|出行)/i,
});

const GENERIC_PHRASES = /(?:这个|那个|我的|以后|未来|之后|接下来|先|作为|放到|放进|记录到|目标|计划|规划|方向|推进|一下|一条)/g;
const SPECIFIC_DOMAINS = new Set(["personal_os_product", "finance_role", "property", "family", "health", "learning", "travel"]);

export function normalizeGoalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/goal\s*(?:&|and)?\s*plan/gi, "")
    .replace(GENERIC_PHRASES, "")
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
    .trim();
}

function ngrams(value, size = 2) {
  const text = normalizeGoalText(value);
  if (!text) return new Set();
  if (text.length <= size) return new Set([text]);
  const values = new Set();
  for (let index = 0; index <= text.length - size; index += 1) values.add(text.slice(index, index + size));
  return values;
}

function overlapCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

function diceCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function domains(value) {
  const text = String(value || "");
  return new Set(Object.entries(DOMAIN_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name));
}

function corpus(goal) {
  return [goal?.title, goal?.description, goal?.summary, goal?.why, goal?.notes, goal?.raw_text, goal?.original_input]
    .filter(Boolean)
    .join(" ");
}

function compatibleType(left, right) {
  const leftFinancial = left === "FinancialItem";
  const rightFinancial = right === "FinancialItem";
  return leftFinancial === rightFinancial;
}

export function goalMatchScore(incoming, existing) {
  if (!existing || CLOSED_STATUSES.has(existing.status)) return 0;
  if (!compatibleType(incoming?.type, existing.type)) return 0;

  const incomingTitle = normalizeGoalText(incoming?.title);
  const existingTitle = normalizeGoalText(existing.title);
  if (incomingTitle && existingTitle && incomingTitle === existingTitle) return 1;
  if (incomingTitle.length >= 4 && existingTitle.length >= 4
    && (incomingTitle.includes(existingTitle) || existingTitle.includes(incomingTitle))) return 0.96;

  const titleDice = diceCoefficient(ngrams(incoming?.title), ngrams(existing.title));
  const contentOverlap = overlapCoefficient(ngrams(corpus(incoming)), ngrams(corpus(existing)));
  const incomingDomains = domains(corpus(incoming));
  const existingDomains = domains(corpus(existing));
  const domainOverlap = overlapCoefficient(incomingDomains, existingDomains);
  const sameCategory = incoming?.category && existing.category && incoming.category === existing.category ? 1 : 0;
  const sameHorizon = incoming?.horizon && existing.horizon && incoming.horizon === existing.horizon ? 1 : 0;

  let score = titleDice * 0.34 + contentOverlap * 0.36 + domainOverlap * 0.2 + sameCategory * 0.07 + sameHorizon * 0.03;
  const specificDomainMatch = [...incomingDomains].some((name) => SPECIFIC_DOMAINS.has(name) && existingDomains.has(name));
  if (specificDomainMatch && contentOverlap >= 0.22) score = Math.max(score, 0.66 + titleDice * 0.12);
  return Number(Math.min(1, score).toFixed(4));
}

export function findExistingGoalMatch(incoming, goals = [], { threshold = 0.58, ambiguityMargin = 0.08 } = {}) {
  const ranked = goals
    .map((goal) => ({ goal, score: goalMatchScore(incoming, goal) }))
    .filter((item) => item.score >= threshold)
    .sort((left, right) => right.score - left.score || String(right.goal.updated_at || "").localeCompare(String(left.goal.updated_at || "")));
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].score < 0.96 && ranked[0].score - ranked[1].score < ambiguityMargin) return null;
  return ranked[0];
}

function containsMeaning(existing, incoming) {
  const existingText = normalizeGoalText(existing);
  const incomingText = normalizeGoalText(incoming);
  if (!incomingText) return true;
  if (!existingText) return false;
  if (existingText.includes(incomingText)) return true;
  return overlapCoefficient(ngrams(incomingText), ngrams(existingText)) >= 0.86;
}

export function mergeGoalText(existing, incoming, label = "补充") {
  const current = String(existing || "").trim();
  const addition = String(incoming || "").trim();
  if (!addition || containsMeaning(current, addition)) return current;
  if (!current || containsMeaning(addition, current)) return addition;
  return `${current}\n\n${label}：${addition}`;
}

export function mergeGoalPlanUpdate(existing, incoming, explicit = {}) {
  const update = {
    description: mergeGoalText(existing.description, incoming.description),
    notes: mergeGoalText(existing.notes, incoming.notes, "对话补充"),
  };

  if (!existing.horizon || explicit.horizon) update.horizon = incoming.horizon || existing.horizon || "medium";
  if (explicit.status && incoming.status) update.status = incoming.status;
  if (explicit.priority && incoming.priority) update.priority = incoming.priority;
  if (explicit.progress_percent && incoming.progress_percent !== null && incoming.progress_percent !== undefined) {
    update.progress_percent = incoming.progress_percent;
  }
  if (existing.category === "Personal" || existing.category === "Other") update.category = incoming.category || existing.category;
  if (["Idea", "LongTermItem"].includes(existing.type) && ["Goal", "Plan"].includes(incoming.type)) update.type = incoming.type;

  for (const key of ["target_date", "target_month", "target_year", "start_date", "review_date", "deadline", "counterparty", "financial_type", "client_id", "contact_id", "company_id"]) {
    if (incoming[key] !== null && incoming[key] !== undefined && incoming[key] !== "") update[key] = incoming[key];
  }
  for (const key of ["amount_total", "amount_completed", "currency"]) {
    if (explicit[key] && incoming[key] !== null && incoming[key] !== undefined && incoming[key] !== "") update[key] = incoming[key];
  }
  return update;
}

export function filterGoalsForRead(goals = [], { horizon, status, query, include_closed = false } = {}) {
  const search = normalizeGoalText(query);
  return goals.filter((goal) => {
    if (!include_closed && CLOSED_STATUSES.has(goal.status)) return false;
    if (horizon && goal.horizon !== horizon) return false;
    if (status && goal.status !== status) return false;
    if (search) {
      const goalText = normalizeGoalText(corpus(goal));
      if (!goalText.includes(search) && overlapCoefficient(ngrams(search), ngrams(goalText)) < 0.6) return false;
    }
    return true;
  });
}

export function completeGoalPatch() {
  return { status: "Completed", progress_percent: 100, archived_at: null };
}

export function isPersistedObjectResult(responseOk, result) {
  return responseOk === true && result?.success === true && typeof result.id === "string" && result.id.length > 0;
}
