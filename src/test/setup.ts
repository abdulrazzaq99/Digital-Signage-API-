import { config } from "dotenv";
import { testEnvFile } from "./envFile.js";

config({ path: testEnvFile, override: true });
process.env.NODE_ENV = "test";
