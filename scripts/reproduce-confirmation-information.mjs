import { simulateCaptures } from "./test-support/capture-intake-simulation.mjs";
const raw_text = "是的是的，因为我在考虑怎么样把这些虚构材料放进去，怎么样做数据封装。";
console.log(JSON.stringify(await simulateCaptures([
  { raw_text, type: "task", title: "整理虚构客户档案", requested_date: "2026-10-19", reminder_policy: "none" },
  { raw_text, type: "task", title: "整理虚构客户档案", requested_date: "2026-10-19", reminder_policy: "none",
    confirmed: true, context: { previous_question: "要创建这条虚构待办吗？", user_confirmed: true } },
]), null, 2));
