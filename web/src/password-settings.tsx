import { KeyRound } from "lucide-react";
import { useState } from "react";
import { api } from "./types";

export function PasswordSettings({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="password-settings" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (password.length < 12) { setError("新密码至少需要 12 位。"); return; }
    if (password !== confirm) { setError("两次输入的新密码不一致。"); return; }
    setBusy(true);
    try {
      await api("/password", { current_password: current, new_password: password, confirm_password: confirm });
      setCurrent(""); setPassword(""); setConfirm("");
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <h2>修改密码</h2>
    <p>更换后，网页版和所有客户端都需要用新密码重新登录。账目不受影响。</p>
    <label>当前密码<input type="password" autoComplete="current-password" required maxLength={1024} value={current} disabled={busy} onChange={e => setCurrent(e.target.value)} /></label>
    <label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} placeholder="至少 12 位" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
    <label>确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button aria-label={busy ? "修改中…" : "修改密码并重新登录"} title={busy ? "修改中…" : "修改密码并重新登录"} className="primary" disabled={busy}><KeyRound size={18} aria-hidden="true" /></button>
  </form>;
}
