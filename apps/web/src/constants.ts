/** 前端常量 */

export const MODEL_OPTIONS = [
  { value: "qwen-flash", label: "qwen-flash" },
  { value: "qwen-plus", label: "qwen-plus" },
  { value: "qwen-max", label: "qwen-max" },
] as const;

export const QUICK_PROMPTS = [
  "帮我百度搜索iphone 18 pro预计什么时候发布，并给到我关键信息。",
  "帮我去百度搜索什么是计算机科学，搜索完成后帮我截图。",
  "帮我去百度搜索iphone 18 pro，然后滚动到页面底部。",
  "帮我去百度搜索iphone 18 pro，然后向下滚动300px，向上滚动100px。",
  "帮我解释一下什么是人工智能"
];
