import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone", // small, self-contained build for Docker / Dokploy
  // pdfkit loads its font files from disk at runtime, so it must not be bundled,
  // and its font files must be copied into the standalone build.
  serverExternalPackages: ["pdfkit", "pg-boss", "openai"],
  outputFileTracingIncludes: {
    "/quotations/[id]/pdf": ["./node_modules/pdfkit/js/data/**", "./node_modules/pdfkit/js/standard-fonts/**", "./public/brand/**"],
  },
  // Old addresses (before Settings existed) keep working.
  async redirects() {
    return [
      { source: "/approvals", destination: "/quotations", permanent: false },
      { source: "/catalogue", destination: "/settings/price-list", permanent: false },
      { source: "/catalogue/new", destination: "/settings/price-list/new", permanent: false },
      { source: "/catalogue/:id", destination: "/settings/price-list/:id", permanent: false },
      { source: "/policy", destination: "/settings/payment-terms", permanent: false },
      { source: "/terms", destination: "/settings/terms", permanent: false },
      { source: "/terms/:id", destination: "/settings/terms/:id", permanent: false },
      { source: "/users", destination: "/settings/users", permanent: false },
      { source: "/audit", destination: "/settings/activity", permanent: false },
    ];
  },
};

export default config;
