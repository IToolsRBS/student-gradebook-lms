import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
  createAuthRouter,
  createRequireAuth,
  createSessionMiddleware,
  resolveAuthConfig
} from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const app = express();

const ENV_FILE_NAMES = [".env", ".env.txt"];

function normalizeMotherduckToken(raw) {
  let token = String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  token = token.replace(/\s+/g, "");
  if (token.startsWith("md_")) {
    token = token.slice(3);
  }
  return token;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim().replace(/^["']|["']$/g, "");
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!key || !value) continue;
    const normalized =
      key === "MOTHERDUCK_TOKEN" ? normalizeMotherduckToken(value) : value;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = normalized;
    }
  }
}

function loadProjectEnvFiles() {
  const loaded = [];
  const dirs = [projectRoot, __dirname, process.cwd()];
  for (const dir of dirs) {
    for (const name of ENV_FILE_NAMES) {
      const filePath = path.join(dir, name);
      if (!fs.existsSync(filePath)) continue;
      parseEnvFile(filePath);
      if (!loaded.includes(filePath)) loaded.push(filePath);
    }
  }
  return loaded;
}

const loadedEnvFiles = loadProjectEnvFiles();

const port = Number(process.env.PORT || 3000);
const motherduckToken = (() => {
  const raw = readEnvValue(["MOTHERDUCK_TOKEN"]);
  return raw ? normalizeMotherduckToken(raw) : null;
})();
const motherduckDatabase =
  readEnvValue(["MOTHERDUCK_DATABASE"]) || "regent_data_platform_prod";
const warehouseSchema =
  readEnvValue(["WAREHOUSE_GRADEBOOK_SCHEMA", "WAREHOUSE_SCHEMA"]) ||
  "moodle_processed";
const stagingSchema =
  readEnvValue(["WAREHOUSE_STAGING_SCHEMA"]) || "moodle_staging";
const dimSchema = readEnvValue(["WAREHOUSE_DIM_SCHEMA"]) || "moodle_processed";
const programmesCacheTtlMs = Number(
  readEnvValue(["PROGRAMMES_CACHE_TTL_MS"]) || "60000"
);
const categoriesCacheTtlMs = Number(
  readEnvValue(["CATEGORIES_CACHE_TTL_MS"]) || "60000"
);
const programmesCache = new Map();
let categoriesCache = null;
const exportJobs = new Map();
const EXPORT_JOB_TTL_MS = 1000 * 60 * 30;

function readEnvFromFile(filePath, keys) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const left = line.slice(0, idx).trim().replace(/^["']|["']$/g, "");
    const right = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (keys.includes(left) && right) return right;
  }
  return null;
}

function readEnvValue(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  for (const dir of [projectRoot, __dirname, process.cwd()]) {
    for (const name of ENV_FILE_NAMES) {
      const fromFile = readEnvFromFile(path.join(dir, name), keys);
      if (fromFile) return fromFile;
    }
  }
  return null;
}

const exportOutputDir =
  readEnvValue(["EXPORT_OUTPUT_DIR"]) ||
  path.join(os.tmpdir(), "gradebook-exports");
fs.mkdirSync(exportOutputDir, { recursive: true });

const pythonBin =
  readEnvValue(["PYTHON_BIN"]) ||
  (process.platform === "win32" ? "python" : "python3");
const host = readEnvValue(["HOST"]) || "0.0.0.0";

let authConfig = { enabled: false };
try {
  authConfig = resolveAuthConfig(readEnvValue);
} catch (error) {
  console.error(`Microsoft sign-in config error: ${error.message}`);
  process.exit(1);
}

if (authConfig.enabled) {
  app.set("trust proxy", 1);
}

function motherduckEnv() {
  return {
    MOTHERDUCK_TOKEN: motherduckToken
      ? normalizeMotherduckToken(motherduckToken)
      : motherduckToken,
    MOTHERDUCK_DATABASE: motherduckDatabase,
    WAREHOUSE_GRADEBOOK_SCHEMA: warehouseSchema,
    WAREHOUSE_STAGING_SCHEMA: stagingSchema,
    WAREHOUSE_DIM_SCHEMA: dimSchema
  };
}

function requireMotherduck() {
  if (!motherduckToken) {
    throw new Error("Missing MOTHERDUCK_TOKEN in environment/.env");
  }
}

function runProcess(command, args, cwd, extraEnv = {}, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const logPrefix = String(options.logPrefix || "").trim();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv }
    });
    let output = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushLines = (buffer, logger) => {
      const parts = buffer.split(/\r?\n/);
      const remainder = parts.pop() || "";
      for (const line of parts) {
        const text = line.trimEnd();
        if (!text) continue;
        if (logPrefix) logger(`${logPrefix} ${text}`);
        else logger(text);
      }
      return remainder;
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      output += text;
      stdoutBuffer += text;
      stdoutBuffer = flushLines(stdoutBuffer, console.info);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      output += text;
      stderrBuffer += text;
      stderrBuffer = flushLines(stderrBuffer, console.warn);
    });
    child.on("close", (code) => {
      const finalStdout = stdoutBuffer.trim();
      const finalStderr = stderrBuffer.trim();
      if (finalStdout) {
        if (logPrefix) console.info(`${logPrefix} ${finalStdout}`);
        else console.info(finalStdout);
      }
      if (finalStderr) {
        if (logPrefix) console.warn(`${logPrefix} ${finalStderr}`);
        else console.warn(finalStderr);
      }
      if (logPrefix) {
        console.info(
          `${logPrefix} finished with exit=${Number(code || 0)} in ${Date.now() - startedAt}ms`
        );
      }
      resolve({
        code: Number(code || 0),
        output,
        elapsedMs: Date.now() - startedAt
      });
    });
  });
}

async function runWarehouseList(command, extraArgs = []) {
  const result = await runProcess(
    pythonBin,
    ["warehouse_list.py", command, ...extraArgs],
    projectRoot,
    motherduckEnv()
  );
  if (result.code !== 0) {
    throw new Error(result.output || `warehouse_list ${command} failed`);
  }
  const lines = result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

function makeJobId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [jobId, job] of exportJobs.entries()) {
    if (now - Number(job.updatedAt || now) > EXPORT_JOB_TTL_MS) {
      exportJobs.delete(jobId);
    }
  }
}

function updateJob(jobId, patch) {
  const current = exportJobs.get(jobId);
  if (!current) return;
  exportJobs.set(jobId, { ...current, ...patch, updatedAt: Date.now() });
}

async function readFileWithRetry(filePath, maxAttempts = 6, baseDelayMs = 400) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fs.promises.readFile(filePath);
    } catch (error) {
      lastError = error;
      const retryable =
        error?.code === "EBUSY" ||
        error?.code === "EPERM" ||
        error?.code === "EACCES";
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt)
      );
    }
  }
  throw lastError;
}

app.use(express.json());

if (authConfig.enabled) {
  app.use(createSessionMiddleware(authConfig));
  app.use("/auth", createAuthRouter(authConfig));
  app.use(createRequireAuth(authConfig));
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gradebook-export",
    warehouse: Boolean(motherduckToken),
    database: motherduckDatabase,
    dropdownSource: "motherduck",
    auth: authConfig.enabled ? "microsoft" : "disabled"
  });
});

app.get("/api/categories", async (_req, res) => {
  try {
    requireMotherduck();
    const now = Date.now();
    if (
      categoriesCache &&
      now - categoriesCache.cachedAt < categoriesCacheTtlMs
    ) {
      return res.json(categoriesCache.value);
    }
    const categories = await runWarehouseList("categories");
    categoriesCache = { cachedAt: now, value: categories };
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/programmes", async (req, res) => {
  const categoryName = String(req.query.categoryName || "").trim();
  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  try {
    requireMotherduck();
    const cacheKey = categoryName;
    const skipCache =
      String(req.query.refresh || "").toLowerCase() === "1" ||
      String(req.query.refresh || "").toLowerCase() === "true";
    const cached = programmesCache.get(cacheKey);
    if (
      !skipCache &&
      cached &&
      Date.now() - cached.cachedAt < programmesCacheTtlMs
    ) {
      return res.json(cached.value);
    }
    const programmes = await runWarehouseList("programmes", [
      "--category-name",
      categoryName
    ]);
    programmesCache.set(cacheKey, {
      cachedAt: Date.now(),
      value: programmes
    });
    res.json(programmes);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/export-excel/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const programmeCode = String(req.body?.programmeCode || "")
    .trim()
    .toUpperCase();

  if (!programmeCode || !categoryName) {
    return res
      .status(400)
      .json({ error: "categoryName and programmeCode are required" });
  }
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  exportJobs.set(jobId, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCode,
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] programme=${programmeCode} category=${categoryName}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: "Building Excel from MotherDuck gradebook marts..."
      });

      const exportResult = await runProcess(
        pythonBin,
        [
          "populate_gradebook_from_warehouse.py",
          "--programme-code",
          programmeCode,
          "--category-name",
          categoryName,
          "--warehouse-schema",
          warehouseSchema,
          "--output-dir",
          exportOutputDir
        ],
        projectRoot,
        motherduckEnv(),
        { logPrefix: `[export-job:${jobId}][excel]` }
      );

      if (exportResult.code !== 0) {
        const logTail = exportResult.output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        return updateJob(jobId, {
          status: "failed",
          stage: "excel",
          message: "Excel export failed",
          error: logTail || "Excel export failed",
          logs: exportResult.output
        });
      }

      const lines = exportResult.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const exportedPath = lines[lines.length - 1];
      if (!exportedPath || !fs.existsSync(exportedPath)) {
        return updateJob(jobId, {
          status: "failed",
          stage: "excel",
          message: "Export file was not created",
          logs: exportResult.output
        });
      }

      const totalMs = Date.now() - startedAt;
      updateJob(jobId, {
        status: "done",
        stage: "done",
        message: "Export complete. Ready to download.",
        filePath: exportedPath,
        fileName: path.basename(exportedPath),
        timingsMs: {
          excel: exportResult.elapsedMs,
          total: totalMs
        }
      });
      console.info(
        `[export-job:${jobId}] done excel=${exportResult.elapsedMs}ms total=${totalMs}ms`
      );
    } catch (error) {
      updateJob(jobId, {
        status: "failed",
        message: "Unexpected export failure",
        stage: "error",
        error: String(error?.message || error)
      });
      console.error(`[export-job:${jobId}] failed`, error);
    }
  })();

  res.json({ ok: true, jobId });
});

app.get("/api/export-excel/jobs/:jobId", (req, res) => {
  cleanupOldJobs();
  const job = exportJobs.get(String(req.params.jobId || ""));
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

app.get("/api/export-excel/jobs/:jobId/download", async (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = exportJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "done" || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(409).json({ error: "Export not ready for download" });
  }
  const fileName = job.fileName || path.basename(job.filePath);
  try {
    const data = await readFileWithRetry(job.filePath);
    res.setHeader("x-export-ms", String(job.timingsMs?.excel || ""));
    res.setHeader("x-total-ms", String(job.timingsMs?.total || ""));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.replace(/"/g, "")}"`
    );
    res.send(data);
  } catch (error) {
    console.error(`[export-download:${jobId}]`, error);
    res.status(503).json({
      error:
        error?.code === "EBUSY"
          ? "Export file is temporarily locked. Please try again in a few seconds."
          : `Could not read export file: ${error?.message || error}`
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, host, () => {
  console.log(`Gradebook export UI listening on ${host}:${port}`);
  console.log(`Python runtime: ${pythonBin}`);
  if (loadedEnvFiles.length) {
    console.log(`Env file(s): ${loadedEnvFiles.join(", ")}`);
  } else {
    console.warn(
      `No .env found. Create ${path.join(projectRoot, ".env")} with MOTHERDUCK_TOKEN=...`
    );
  }
  if (!motherduckToken) {
    console.warn("MOTHERDUCK_TOKEN not set — dropdowns and export will fail.");
  } else {
    console.log(`MotherDuck database: md:${motherduckDatabase}`);
    console.log(
      `Schemas: staging=${stagingSchema}, dim=${dimSchema}, gradebook=${warehouseSchema}`
    );
  }
  if (authConfig.enabled) {
    console.log(`Microsoft sign-in enabled (tenant ${authConfig.tenantId})`);
    console.log(`Auth redirect URI: ${authConfig.redirectUri}`);
  } else {
    console.warn(
      "Microsoft sign-in disabled — set AZURE_CLIENT_ID and related env vars to enable."
    );
  }
});
