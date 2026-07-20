import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    // Recent-search list lives in the JWT itself (no DB in this project) so
    // it's tied to the Google account rather than the browser — client calls
    // useSession().update({ recent }) (see lib/recent.ts's useRecent), which
    // arrives here as `trigger === "update"`.
    async jwt({ token, trigger, session }) {
      if (trigger === "update" && session?.recent) {
        token.recent = session.recent;
      }
      return token;
    },
    async session({ session, token }) {
      session.recent = (token.recent as typeof session.recent) ?? [];
      return session;
    },
  },
});
