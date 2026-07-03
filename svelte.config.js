import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ out: "build" }),
    csrf: {
      // SvelteKit's built-in origin check can't exempt the email ingest
      // webhook (cross-origin multipart POSTs authenticated by bearer token).
      // CSRF protection is handled by the double-submit cookie check in
      // src/hooks.server.ts (see server/csrf.ts).
      checkOrigin: false,
    },
    files: {
      assets: "public",
    },
    typescript: {
      config: (tsconfig) => ({
        ...tsconfig,
        // Typecheck the app source, matching the pre-SvelteKit typecheck
        // scope (src only). Server, shared, test, and eval code runs under
        // bun and is exercised by `bun test`.
        include: tsconfig.include.filter((pattern) => !pattern.startsWith("../test")),
      }),
    },
  },
};

export default config;
