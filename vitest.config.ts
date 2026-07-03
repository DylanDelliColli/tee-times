import { defineConfig } from "vitest/config";

export default defineConfig({
  // Force the automatic JSX runtime for esbuild's transform regardless of
  // which tsconfig.json vite/vitest resolves as "nearest" for a given file.
  // Without this, files under web/ pick up web/tsconfig.json's "jsx" setting
  // — and Next.js's own build MANDATORILY rewrites that file's jsx to
  // "preserve" every time `next build`/`next dev` runs (a documented Next
  // behavior, not something we can opt out of), which would otherwise break
  // every web component test with "React is not defined". Setting this here
  // makes vitest's JSX handling independent of that file entirely, so `next
  // build` and `vitest run` can coexist without fighting over the same
  // tsconfig.json.
  // Vite/Vitest 4 switched the default transform pipeline from esbuild to
  // oxc (rolldown-oxc). oxc silently wins over `esbuild` options when both
  // are set (with a warning), so the equivalent JSX setting must move to
  // `oxc.jsx` to keep automatic-runtime JSX independent of tsconfig.json's
  // "jsx" setting for the reasons explained above.
  oxc: {
    jsx: "automatic",
  },
  test: {
    // .tsx web-component tests live alongside the plain .ts core tests; both
    // patterns are included here, but web tests opt into jsdom individually
    // via a per-file `// @vitest-environment jsdom` pragma (see
    // test/web/search-view.test.tsx / test/web/search.e2e.test.ts) so the 191
    // pre-existing node-env core tests are entirely unaffected.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
