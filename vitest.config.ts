import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
