import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import Providers from "@/components/Providers";
import "./globals.css";

const GA_ID = "G-7TCC1MQPYP";

// Inter is what both attached brand specs use for Latin/digits (Voltagent
// directly; Airtable's Haas Grotesk substitutes to Inter Display) — self-
// hosted via next/font. Its Hangul coverage doesn't exist, so Korean text
// falls through to Noto Sans KR, loaded the normal way via a <link> below
// (next/font/google doesn't self-host Noto Sans KR's Hangul subset).
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Chart Deep Dive — 종목 차트 기술적 분석",
  description:
    "종목을 검색하고 캔들 차트 위에 기본 지표·차트 패턴·고급 기법을 겹쳐 분석합니다.",
};

// Apply the saved theme before first paint to avoid a light/dark flash.
const themeInit = `(function(){try{var t=localStorage.getItem('cdd-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning className={inter.variable}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <Providers>{children}</Providers>
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
        <Script id="ga4-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
        </Script>
      </body>
    </html>
  );
}
