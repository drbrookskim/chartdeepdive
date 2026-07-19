"use client";

import { useState } from "react";
import { useSession, signOut } from "next-auth/react";

/** Avatar+name chip shown when logged in; clicking opens a confirm dialog
 * (avatar/name/question + 취소/로그아웃) instead of signing out immediately. */
export default function UserChip() {
  const { data: session } = useSession();
  const [confirming, setConfirming] = useState(false);

  if (!session) return null;

  const initial = session.user?.name?.slice(0, 1) ?? "?";

  return (
    <>
      <button className="useridchip" onClick={() => setConfirming(true)} title="로그아웃">
        {session.user?.image ? (
          <img src={session.user.image} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="useridchip__fallback">{initial}</span>
        )}
        {session.user?.name}
      </button>
      {confirming && (
        <div className="logoutmodal__overlay" onClick={() => setConfirming(false)}>
          <div className="logoutmodal" onClick={(e) => e.stopPropagation()}>
            <button
              className="logoutmodal__close"
              onClick={() => setConfirming(false)}
              aria-label="닫기"
            >
              ×
            </button>
            {session.user?.image ? (
              <img className="logoutmodal__avatar" src={session.user.image} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="logoutmodal__avatar logoutmodal__avatar--fallback">{initial}</span>
            )}
            <div className="logoutmodal__name">{session.user?.name}</div>
            <div className="logoutmodal__question">로그아웃 하시겠습니까?</div>
            <div className="logoutmodal__actions">
              <button className="logoutmodal__cancel" onClick={() => setConfirming(false)}>
                취소
              </button>
              <button className="logoutmodal__confirm" onClick={() => signOut()}>
                로그아웃
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
