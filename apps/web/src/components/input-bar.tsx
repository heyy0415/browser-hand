import {
  type FC,
  type FormEvent,
  type KeyboardEvent,
  useState,
  useRef,
  useEffect,
} from "react";

interface InputBarProps {
  loading: boolean;
  onSubmit: (input: string) => Promise<void>;
}

export const InputBar: FC<InputBarProps> = ({ loading, onSubmit }) => {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自适应高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim() || loading) {
      return;
    }
    const question = input;
    setInput("");
    await onSubmit(question);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!loading && input.trim()) {
        void onSubmit(input.trim());
        setInput("");
      }
    }
  };

  return (
    <footer className="bh-input-wrap">
      <form className="bh-input-form" onSubmit={handleSubmit}>
        <div className="bh-input-box">
          <textarea
            ref={textareaRef}
            className="bh-input"
            disabled={loading}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="请描述你想在网页上执行的操作"
            rows={4}
            value={input}
          />
          <button
            className="bh-send"
            disabled={loading || !input.trim()}
            type="submit"
          >
            <svg
              className="icon"
              viewBox="0 0 1024 1024"
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
            >
              <path
                d="M260.315429 711.789714l328.923428-328.923428a36.717714 36.717714 0 1 1 51.931429 51.931428l-233.654857 233.618286 181.723428 181.686857L848.822857 175.213714 173.897143 434.761143l129.828571 129.828571-51.931428 51.894857-167.899429-167.862857a36.717714 36.717714 0 0 1 12.653714-60.196571L900.827429 75.702857a36.717714 36.717714 0 0 1 47.542857 47.506286L635.574857 927.451429a36.717714 36.717714 0 0 1-60.16 12.653714l-219.794286-219.794286-21.577142 21.577143 41.947428 72.667429a36.717714 36.717714 0 1 1-63.561143 36.681142L238.994286 724.114286l21.321143-12.288z"
                fill="#ffffff"
                p-id="4806"
              ></path>
            </svg>
          </button>
        </div>
      </form>
      <div className="bh-disclaimer">
        BrowserHand 可能会犯错，请核实重要信息
      </div>
    </footer>
  );
};
