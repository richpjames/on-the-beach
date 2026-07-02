import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ out: "build" }),
    csrf: {
      // The app has no cookie-based auth, and the email ingest webhook
      // receives cross-origin multipart POSTs (authenticated by bearer token).
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
