import { type FC, type FormEvent, type KeyboardEvent, useState } from 'react';

interface InputBarProps {
  loading: boolean;
  onSubmit: (input: string) => Promise<void>;
}

export const InputBar: FC<InputBarProps> = ({ loading, onSubmit }) => {
  const [input, setInput] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim() || loading) {
      return;
    }

    const question = input;
    setInput('');
    await onSubmit(question);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!loading && input.trim()) {
        void onSubmit(input.trim());
        setInput('');
      }
    }
  };

  return (
    <footer className="b-handinput-wrap">
      <form className="b-handinput-form" onSubmit={handleSubmit}>
        <textarea
          className="b-handinput"
          disabled={loading}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Shift + Enter 换行，Enter发送。"
          rows={2}
          value={input}
        />
        <button className="b-handsend" disabled={loading || !input.trim()} type="submit">
          ↗
        </button>
      </form>
      <div className="b-handdisclaimer">本回答由 BrowserHand 团队生成并提供参考</div>
    </footer>
  );
};
