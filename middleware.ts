import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  if (!req.auth) {
    return NextResponse.redirect(new URL("/", req.url));
  }
});

export const config = {
  matcher: ["/chart/:path*", "/api/ohlcv/:path*", "/api/analysis/:path*", "/api/search/:path*"],
};
