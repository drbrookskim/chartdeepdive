"use client";

import { signIn } from "next-auth/react";

/** Shown when a logged-out user tries to turn on anything beyond the free
 * MA-only chart (see toggleLayer/togglePatterns in app/chart/page.tsx). */
export default function AuthPromptModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="logoutmodal__overlay" onClick={onClose}>
      <div className="logoutmodal" onClick={(e) => e.stopPropagation()}>
        <button className="logoutmodal__close" onClick={onClose} aria-label="닫기">
          ×
        </button>
        <div className="logoutmodal__name">Chart Deep Dive</div>
        <div className="logoutmodal__question">차별화된 차트 분석 서비스를 만끽하세요.</div>
        <button className="googlesignin" onClick={() => signIn("google")}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
            />
            <path
              fill="#FBBC05"
              d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"
            />
          </svg>
          Google로 계속하기
        </button>
      </div>
    </div>
  );
}
