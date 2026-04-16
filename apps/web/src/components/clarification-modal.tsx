import type { FC } from 'react';

interface ClarificationModalProps {
  reply: string;
  questions: string[];
  onSelect: (question: string) => Promise<void>;
}

export const ClarificationModal: FC<ClarificationModalProps> = ({ reply, questions, onSelect }) => (
  <div className="b-handclarification-modal-overlay">
    <div className="b-handclarification-modal">
      <p className="b-handclarification-modal-text">{reply}</p>
      <div className="b-handclarification-modal-buttons">
        {questions.map((question, index) => (
          <button
            key={index}
            className="b-handclarification-modal-button"
            type="button"
            onClick={() => void onSelect(question)}
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  </div>
);
