import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone", // small, self-contained build for Docker / Dokploy
};

export default config;
