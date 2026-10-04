import type { Question } from "../api/types";

export interface QuestionCardProps {
  question: Question;
  busy: boolean;
  onAnswer: (option: string) => void;
}

export function QuestionCard({ question, busy, onAnswer }: QuestionCardProps) {
  return (
    <section class="card question-card" data-testid="question-card">
      <p>{question.text}</p>
      {question.evidence ? <p class="note">{question.evidence}</p> : null}
      <div class="options">
        {question.options.map((option) => (
          <button
            type="button"
            key={option}
            disabled={busy}
            onClick={() => {
              if (!busy) onAnswer(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  );
}
