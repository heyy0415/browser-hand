/** 前端常量 */

export const MODEL_OPTIONS = [
  { value: "qwen-flash", label: "qwen-flash" },
  { value: "qwen-plus", label: "qwen-plus" },
  { value: "qwen-max", label: "qwen-max" },
] as const;

export const QUICK_PROMPTS = [
  "帮我去淘宝搜索一个iphone 15",
  "帮我去搜索一个iphone 15",
  "帮我打开百度，获取第一条热搜内容。",
  "当前页面向下滚动300px，向上滚动100px。",
  "帮我打开百度，输入什么是计算机科学，然后点击百度一下。",
  "帮我解释一下什么是人工智能",
];

export const STEP_LABELS: Record<string, string> = {
  intention: "意图解析",
  scanner: "页面扫描",
  vector: "向量分析",
  abstractor: "操作规划",
  runner: "执行操作",
};

export const STEP_ICONS: Record<string, string> = {
  intention: "",
  scanner: "",
  vector: "",
  abstractor: "",
  runner: "",
};
