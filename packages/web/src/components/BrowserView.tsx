/**
 * 浏览器截图展示
 */

import { useSSE } from "../hooks/useSSE";

interface BrowserViewProps {
  sessionId: string | null;
  screenshotData?: string;
}

export function BrowserView({ screenshotData }: BrowserViewProps) {
  if (!screenshotData) {
    return (
      <div className="browser-view browser-empty">
        <p>等待浏览器截图...</p>
      </div>
    );
  }

  return (
    <div className="browser-view">
      <img
        src={`data:image/jpeg;base64,${screenshotData}`}
        alt="浏览器当前页面"
        className="browser-screenshot"
      />
    </div>
  );
}
