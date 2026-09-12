import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  skipProxyUrlNormalize: true,
  agentRules: false,
  outputFileTracingExcludes: {
    "/*": [
      "./.env*",
      "./evidence/**/*",
      "./.studio-data/**/*",
      "./scripts/**/*",
      "./tests/**/*",
      "./.git/**/*",
    ],
  },
};
export default config;
