/**
 * 会话持久化存储
 * 
 * 使用 JSON 文件存储会话数据，每个会话一个文件
 */

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "../../../data/sessions");

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** SSE 事件类型标记（thinking/action/observation/done/error/screenshot） */
  eventType?: string;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 确保数据目录存在 */
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 创建新会话 */
export async function createSession(title?: string): Promise<Session> {
  await ensureDataDir();
  const session: Session = {
    id: generateId(),
    title: title || "新会话",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveSession(session);
  return session;
}

/** 保存会话到文件 */
export async function saveSession(session: Session): Promise<void> {
  await ensureDataDir();
  session.updatedAt = Date.now();
  const filePath = join(DATA_DIR, `${session.id}.json`);
  await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
}

/** 获取单个会话 */
export async function getSession(id: string): Promise<Session | null> {
  try {
    const filePath = join(DATA_DIR, `${id}.json`);
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Session;
  } catch {
    return null;
  }
}

/** 获取所有会话列表（按更新时间倒序） */
export async function getAllSessions(): Promise<Omit<Session, "messages">[]> {
  await ensureDataDir();
  try {
    const files = await readdir(DATA_DIR);
    const sessions: Omit<Session, "messages">[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(DATA_DIR, file), "utf-8");
        const session = JSON.parse(content) as Session;
        sessions.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
      } catch {}
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  } catch {
    return [];
  }
}

/** 删除会话 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    const filePath = join(DATA_DIR, `${id}.json`);
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 添加消息到会话 */
export async function addMessage(sessionId: string, message: Omit<ChatMessage, "id" | "timestamp">): Promise<ChatMessage> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("会话不存在");

  const chatMsg: ChatMessage = {
    id: generateId(),
    role: message.role,
    content: message.content,
    eventType: message.eventType,
    timestamp: Date.now(),
  };
  session.messages.push(chatMsg);

  // 如果是第一条用户消息，自动设置会话标题
  if (message.role === "user" && session.messages.filter(m => m.role === "user").length === 1) {
    session.title = message.content.slice(0, 50) || "新会话";
  }

  await saveSession(session);
  return chatMsg;
}
