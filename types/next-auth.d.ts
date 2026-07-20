import type { SearchResult } from "@/lib/schema";

declare module "next-auth" {
  interface Session {
    recent?: SearchResult[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    recent?: SearchResult[];
  }
}
