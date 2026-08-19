import { useState, useCallback, useEffect } from "react";
import { HelpCircle, Send } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface Props {
  question: string;
  options?: string[];
  onSubmit: (answer: string) => void;
}

export function QuestionDialog({ question, options = [], onSubmit }: Props) {
  const [customAnswer, setCustomAnswer] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    if (selected) {
      onSubmit(selected);
    } else if (customAnswer.trim()) {
      onSubmit(customAnswer.trim());
    }
  }, [selected, customAnswer, onSubmit]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleSubmit]);

  return (
    <Modal open={true} onClose={() => onSubmit("")} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-full shrink-0" style={{ background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>
            <HelpCircle className="w-5 h-5" style={{ color: "var(--primary)" }} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Agent 提问</h3>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{question}</p>
          </div>
        </div>

        <div className="space-y-2">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => {
                setSelected(opt);
                setCustomAnswer("");
                onSubmit(opt);
              }}
              className="w-full text-left px-4 py-2.5 rounded-xl text-sm transition-all duration-150 cursor-pointer"
              style={{
                border: selected === opt ? "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" : "1px solid var(--border)",
                background: selected === opt ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
                color: selected === opt ? "var(--primary)" : "var(--text-secondary)",
              }}
            >
              {opt}
            </button>
          ))}

          <div className="relative">
            <Input
              type="text"
              value={customAnswer}
              onChange={(e) => {
                setCustomAnswer(e.target.value);
                setSelected(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="输入自定义回答..."
              className="py-2.5 rounded-xl"
              autoFocus
            />
          </div>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={!selected && !customAnswer.trim()}
          className="w-full"
        >
          <Send className="w-4 h-4" />
          提交回答
        </Button>
      </div>
    </Modal>
  );
}
