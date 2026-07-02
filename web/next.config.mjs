/**
 * The core src/ modules use NodeNext-style relative imports with explicit
 * ".js" extensions that resolve to ".ts"/".tsx" source files (matching every
 * other module in this repo, e.g. src/search/search.ts imports
 * "../core/courses.js"). tsc (NodeNext moduleResolution) understands this
 * convention natively; webpack (Next's bundler) does not by default, so
 * without this alias `next build`/`next dev` fail with "Module not found"
 * for every such import from web/. This mirrors webpack 5's own documented
 * pattern for consuming NodeNext-style TypeScript ESM output.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
