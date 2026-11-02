import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone", // small, self-contained build for Docker / Dokploy
  // pdfkit loads its font files from disk at runtime, so it must not be bundled,
  // and its font files must be copied into the standalone build.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/quotations/[id]/pdf": ["./node_modules/pdfkit/js/data/**", "./node_modules/pdfkit/js/standard-fonts/**", "./public/brand/**"],
  },
};

export default config;
