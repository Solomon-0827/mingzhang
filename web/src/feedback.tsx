import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, CircleAlert, X } from "lucide-react";

type Feedback = { kind: "error" | "notice"; text: string };
const CONNECTION_ERROR = "无法连接账本服务，请检查网络后重试。";

export function useFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const setError = useCallback((text: string) => {
    setFeedback(current => text ? { kind: "error", text } : current?.kind === "error" ? null : current);
  }, []);
  const setNotice = useCallback((text: string) => {
    setFeedback(current => text ? { kind: "notice", text } : current?.kind === "notice" ? null : current);
  }, []);
  const clearConnectionError = useCallback(() => {
    setFeedback(current => current?.kind === "error" && current.text === CONNECTION_ERROR ? null : current);
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), feedback.kind === "error" ? 5000 : 3000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const toast = createPortal(
    <AnimatePresence initial={false}>{feedback && (
    <motion.div key={`${feedback.kind}-${feedback.text}`} initial={{ opacity: 0, y: -12, scale: 0.96, x: "-50%" }} animate={{ opacity: 1, y: 0, scale: 1, x: "-50%" }} exit={{ opacity: 0, y: -8, scale: 0.98, x: "-50%" }} transition={{ duration: 0.2 }} className={`feedback-toast ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
      {feedback.kind === "error" ? <CircleAlert size={19} /> : <CircleCheck size={19} />}
      <span>{feedback.text}</span>
      <button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}><X size={16} /></button>
    </motion.div>
    )}</AnimatePresence>, document.body,
  );
  return { setError, setNotice, clearConnectionError, toast };
}
