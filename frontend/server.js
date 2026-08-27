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
  resolveAuthConfig,
  getAccessForEmail
} from "./auth.js";
import { createAuditLogger } from "./audit-log.js";
import { createAuditDb } from "./audit-db.js";

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
// Full intake exports can include ~40 programmes; keep headroom above that.
const MAX_BATCH_PROGRAMMES = Math.max(
  40,
  Number(process.env.MAX_BATCH_PROGRAMMES || 50) || 50
);

function assertBatchProgrammeLimit(programmeCodes, res) {
  if (programmeCodes.length <= MAX_BATCH_PROGRAMMES) return true;
  res.status(400).json({
    error:
      `Too many programmes selected (${programmeCodes.length}). ` +
      `Export at most ${MAX_BATCH_PROGRAMMES} programmes per batch to avoid server timeouts — split into smaller batches.`
  });
  return false;
}

const MAX_BATCH_CATEGORIES = Math.max(
  20,
  Number(process.env.MAX_BATCH_CATEGORIES || 50) || 50
);

function assertBatchCategoryLimit(categoryNames, res) {
  if (categoryNames.length <= MAX_BATCH_CATEGORIES) return true;
  res.status(400).json({
    error:
      `Too many intakes selected (${categoryNames.length}). ` +
      `Export at most ${MAX_BATCH_CATEGORIES} intakes per batch to avoid server timeouts — split into smaller batches.`
  });
  return false;
}

function parseCategoryNames(body) {
  const rawNames = Array.isArray(body?.categoryNames)
    ? body.categoryNames
    : body?.categoryName
      ? [body.categoryName]
      : [];
  return [
    ...new Set(
      rawNames.map((name) => String(name || "").trim()).filter(Boolean)
    )
  ];
}

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

const auditLogDir =
  readEnvValue(["AUDIT_LOG_DIR"]) || path.join(exportOutputDir, "audit");
const auditDatabaseUrl = readEnvValue([
  "AUDIT_DATABASE_URL",
  "NEON_DATABASE_URL",
  "DATABASE_URL"
]);
const auditDb = createAuditDb({ connectionString: auditDatabaseUrl });

function resolveAppUrl() {
  return (
    readEnvValue(["BASE_URL", "APP_URL", "RENDER_EXTERNAL_URL"]) || ""
  ).replace(/\/$/, "");
}

function resolveAppEnv() {
  const explicit = (
    readEnvValue(["APP_ENV", "AUDIT_APP_ENV", "RENDER_SERVICE_NAME"]) || ""
  )
    .trim()
    .toLowerCase();
  if (explicit === "prod" || explicit === "production") return "prod";
  if (explicit === "dev" || explicit === "development" || explicit === "staging") {
    return explicit === "staging" ? "staging" : "dev";
  }
  if (explicit.includes("dev")) return "dev";
  if (explicit.includes("prod")) return "prod";
  if (explicit.includes("stag")) return "staging";

  const url = resolveAppUrl().toLowerCase();
  if (url.includes("dev") || url.includes("staging") || url.includes("stage")) {
    return url.includes("stag") ? "staging" : "dev";
  }
  if (url.includes("prod") || url) return url ? "prod" : "unknown";
  return "unknown";
}

const appEnv = resolveAppEnv();
const appUrl = resolveAppUrl();

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

    if (options.stdin != null) {
      child.stdin.write(String(options.stdin));
      child.stdin.end();
    }
  });
}

const auditLogger = createAuditLogger({
  logDir: auditLogDir,
  durableDb: auditDb,
  appEnv,
  appUrl
});

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
    if (job.status === "queued" || job.status === "running") {
      continue;
    }
    if (now - Number(job.updatedAt || now) > EXPORT_JOB_TTL_MS) {
      exportJobs.delete(jobId);
    }
  }
}

function publicJobPayload(job) {
  if (!job) return null;
  // Whitelist only — never leak file paths, env noise, or oversized fields.
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    message: job.message,
    error: job.error,
    fileName: job.fileName,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    timingsMs: job.timingsMs || {},
    categoryName: job.categoryName,
    categoryNames: job.categoryNames,
    programmeCodes: job.programmeCodes,
    programmeCode: job.programmeCode,
    reportType: job.reportType
  };
}

function getRequestUser(req) {
  const account = req?.session?.account;
  if (!account?.email) {
    return {
      email: authConfig.enabled ? "unknown" : "local-dev",
      name: account?.name || "",
      role: authConfig.enabled ? "unknown" : "local-dev"
    };
  }
  const access = getAccessForEmail(account.email, authConfig);
  return {
    email: String(account.email).toLowerCase(),
    name: account.name || "",
    role: access.role || account.role || "full"
  };
}

function auditFiltersFromJob(job) {
  if (!job) return null;
  const filters = {};
  if (job.categoryNames?.length) filters.categoryNames = job.categoryNames;
  else if (job.categoryName) filters.categoryName = job.categoryName;
  if (job.programmeCodes?.length) filters.programmeCodes = job.programmeCodes;
  if (job.programmeCode) filters.programmeCode = job.programmeCode;
  if (job.moduleCodes?.length) filters.moduleCodes = job.moduleCodes;
  if (job.assessmentTypes?.length) filters.assessmentTypes = job.assessmentTypes;
  if (job.assessments?.length) filters.assessments = job.assessments;
  if (job.statuses?.length) filters.statuses = job.statuses;
  if (job.inactivityPeriod) filters.inactivityPeriod = job.inactivityPeriod;
  if (job.dueFrom) filters.dueFrom = job.dueFrom;
  if (job.dueTo) filters.dueTo = job.dueTo;
  return Object.keys(filters).length ? filters : null;
}

function writeExportAudit(event, job, extra = {}) {
  const user = job?.requestedBy || {};
  return auditLogger.append({
    event,
    jobId: job?.jobId || null,
    reportType: job?.reportType || "gradebook",
    status: extra.status || job?.status || null,
    userEmail: user.email || extra.userEmail || null,
    userName: user.name || extra.userName || null,
    userRole: user.role || extra.userRole || null,
    filters: auditFiltersFromJob(job),
    fileName: job?.fileName || null,
    error: job?.error || extra.error || null,
    timingsMs: job?.timingsMs || null,
    ...extra
  });
}

function registerExportJob(req, job) {
  const requestedBy = getRequestUser(req);
  const fullJob = {
    ...job,
    requestedBy,
    reportType: job.reportType || "gradebook"
  };
  exportJobs.set(job.jobId, fullJob);
  void writeExportAudit("export_started", fullJob, { status: "queued" }).catch(
    (error) => {
      console.error("[audit] export_started write failed", error);
    }
  );
  return fullJob;
}

function updateJob(jobId, patch) {
  const current = exportJobs.get(jobId);
  if (!current) return;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  exportJobs.set(jobId, next);
  if (
    patch?.status &&
    patch.status !== current.status &&
    (patch.status === "done" || patch.status === "failed")
  ) {
    void writeExportAudit(
      patch.status === "done" ? "export_completed" : "export_failed",
      next,
      { status: patch.status }
    ).catch((error) => {
      console.error("[audit] terminal export write failed", error);
    });
  }
}

async function waitForReadableFile(filePath, maxAttempts = 6, baseDelayMs = 400) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 0) return stat;
      lastError = new Error("Export file is empty");
    } catch (error) {
      lastError = error;
      const retryable =
        error?.code === "EBUSY" ||
        error?.code === "EPERM" ||
        error?.code === "EACCES" ||
        error?.code === "ENOENT";
      if (!retryable || attempt === maxAttempts) break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, baseDelayMs * attempt)
    );
  }
  throw lastError;
}

function sendExportDownload(res, job) {
  const fileName = job.fileName || path.basename(job.filePath);
  res.setHeader("x-export-ms", String(job.timingsMs?.excel || ""));
  res.setHeader("x-total-ms", String(job.timingsMs?.total || ""));
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${String(fileName).replace(/"/g, "")}"`
  );
  // Stream to disk→client without loading the whole workbook into Node memory.
  const stream = fs.createReadStream(job.filePath);
  stream.on("error", (error) => {
    console.error(`[export-download] stream error`, error);
    if (!res.headersSent) {
      res.status(503).json({
        error: `Could not read export file: ${error?.message || error}`
      });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

app.use(express.json());

if (authConfig.enabled) {
  app.use(createSessionMiddleware(authConfig));
  app.use("/auth", createAuthRouter(authConfig));
  app.use(createRequireAuth(authConfig));
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get(["/gradebook", "/gradebook/", "/gradebook.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "gradebook.html"));
});

app.get(
  ["/intake-summary", "/intake-summary/", "/intake-summary.html"],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "intake-summary.html"));
  }
);

app.get(
  [
    "/activity-completion",
    "/activity-completion/",
    "/activity-completion.html"
  ],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "activity-completion.html"));
  }
);

app.get(
  [
    "/inactivity-report",
    "/inactivity-report/",
    "/inactivity-report.html"
  ],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "inactivity-report.html"));
  }
);

app.get(
  [
    "/missed-submission",
    "/missed-submission/",
    "/missed-submission.html"
  ],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "missed-submission.html"));
  }
);

app.get(
  [
    "/late-submission",
    "/late-submission/",
    "/late-submission.html"
  ],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "late-submission.html"));
  }
);

app.get(["/audit-log", "/audit-log/", "/audit-log.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "audit-log.html"));
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

app.get("/api/health", async (_req, res) => {
  let neonReady = false;
  if (auditDb.configured) {
    try {
      neonReady = Boolean(await auditDb.ensureReady());
    } catch {
      neonReady = false;
    }
  }
  res.json({
    ok: true,
    service: "gradebook-export",
    warehouse: Boolean(motherduckToken),
    database: motherduckDatabase,
    dropdownSource: "motherduck",
    auth: authConfig.enabled ? "microsoft" : "disabled",
    audit: {
      neonConfigured: auditDb.configured,
      neonReady,
      localLogPath: auditLogger.logPath,
      appEnv,
      appUrl
    }
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

app.get("/api/modules", async (req, res) => {
  const categoryName = String(req.query.categoryName || "").trim();
  const rawCodes = String(req.query.programmeCodes || "").trim();
  const programmeCodes = [
    ...new Set(
      rawCodes
        .split(",")
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!programmeCodes.length) {
    return res.status(400).json({ error: "programmeCodes is required" });
  }
  try {
    requireMotherduck();
    const modules = await runWarehouseList("modules", [
      "--category-name",
      categoryName,
      "--programme-codes",
      programmeCodes.join(",")
    ]);
    res.json(modules);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/assessments", async (req, res) => {
  const categoryName = String(req.query.categoryName || "").trim();
  const programmeCodes = [
    ...new Set(
      String(req.query.programmeCodes || "")
        .split(",")
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const moduleCodes = [
    ...new Set(
      String(req.query.moduleCodes || "")
        .split(",")
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessmentTypes = [
    ...new Set(
      String(req.query.assessmentTypes || "")
        .split(",")
        .map((type) => String(type || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!programmeCodes.length) {
    return res.status(400).json({ error: "programmeCodes is required" });
  }
  try {
    requireMotherduck();
    const extraArgs = [
      "--category-name",
      categoryName,
      "--programme-codes",
      programmeCodes.join(",")
    ];
    if (moduleCodes.length) {
      extraArgs.push("--module-codes", moduleCodes.join(","));
    }
    if (assessmentTypes.length) {
      extraArgs.push("--assessment-types", assessmentTypes.join(","));
    }
    const assessments = await runWarehouseList("assessments", extraArgs);
    res.json(assessments);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/export-excel/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const rawCodes = Array.isArray(req.body?.programmeCodes)
    ? req.body.programmeCodes
    : req.body?.programmeCode
      ? [req.body.programmeCode]
      : [];
  const programmeCodes = [
    ...new Set(
      rawCodes
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];

  if (!programmeCodes.length || !categoryName) {
    return res.status(400).json({
      error: "categoryName and at least one programmeCode/programmeCodes are required"
    });
  }
  if (!assertBatchProgrammeLimit(programmeCodes, res)) return;
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCodes,
    programmeCode: programmeCodes.length === 1 ? programmeCodes[0] : undefined,
    reportType: "gradebook",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] programmes=${programmeCodes.join(",")} category=${categoryName}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message:
          programmeCodes.length === 1
            ? "Building Excel..."
            : `Building batch Excel for ${programmeCodes.length} programmes...`
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message:
            programmeCodes.length === 1
              ? `Building Excel... (${elapsedSec}s)`
              : `Building batch Excel for ${programmeCodes.length} programmes... (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_gradebook_from_warehouse.py",
        "--category-name",
        categoryName,
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const code of programmeCodes) {
        pythonArgs.push("--programme-code", code);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][excel]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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

app.post("/api/export-intake-summary/start", async (req, res) => {
  const categoryNames = parseCategoryNames(req.body);
  const categoryName =
    categoryNames.length === 1 ? categoryNames[0] : undefined;

  if (!categoryNames.length) {
    return res.status(400).json({
      error: "categoryName or categoryNames is required"
    });
  }
  if (!assertBatchCategoryLimit(categoryNames, res)) return;
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  const isBatch = categoryNames.length > 1;
  const queuedMessage = isBatch
    ? `Queued for batch intake summary export (${categoryNames.length} intakes)...`
    : "Queued for intake summary export...";
  const buildingMessage = isBatch
    ? `Building batch Intake Summary for ${categoryNames.length} intakes...`
    : "Building Intake Summary...";
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: queuedMessage,
    startedAt,
    updatedAt: startedAt,
    categoryName,
    categoryNames,
    reportType: "intake-summary",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] report=intake-summary categories=${categoryNames.join(" | ")}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: buildingMessage
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message: `${buildingMessage} (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_intake_summary.py",
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const name of categoryNames) {
        pythonArgs.push("--category-name", name);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][intake-summary]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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
          message: "Intake summary export failed",
          error: logTail || "Intake summary export failed",
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

app.post("/api/export-activity-completion/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const programmeCodes = [
    ...new Set(
      (Array.isArray(req.body?.programmeCodes) ? req.body.programmeCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const moduleCodes = [
    ...new Set(
      (Array.isArray(req.body?.moduleCodes) ? req.body.moduleCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessmentTypes = [
    ...new Set(
      (Array.isArray(req.body?.assessmentTypes) ? req.body.assessmentTypes : [])
        .map((type) => String(type || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessments = [
    ...new Set(
      (Array.isArray(req.body?.assessments) ? req.body.assessments : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    )
  ];
  const statuses = [
    ...new Set(
      (Array.isArray(req.body?.statuses) ? req.body.statuses : [])
        .map((status) =>
          String(status || "")
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
        )
        .filter(Boolean)
    )
  ];

  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!programmeCodes.length) {
    return res.status(400).json({ error: "At least one programme is required" });
  }
  if (!assertBatchProgrammeLimit(programmeCodes, res)) return;
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for activity completion export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCodes,
    moduleCodes,
    assessmentTypes,
    assessments,
    statuses,
    reportType: "activity-completion",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] report=activity-completion category=${categoryName}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: "Building Activity Completion report..."
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message: `Building Activity Completion report... (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_activity_completion.py",
        "--category-name",
        categoryName,
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const code of programmeCodes) {
        pythonArgs.push("--programme-code", code);
      }
      for (const moduleCode of moduleCodes) {
        pythonArgs.push("--module", moduleCode);
      }
      for (const assessmentType of assessmentTypes) {
        pythonArgs.push("--assessment-type", assessmentType);
      }
      for (const assessment of assessments) {
        pythonArgs.push("--assessment", assessment);
      }
      for (const status of statuses) {
        pythonArgs.push("--status", status);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][activity-completion]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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
          message: "Activity completion export failed",
          error: logTail || "Activity completion export failed",
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

app.post("/api/export-inactivity-report/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const programmeCodes = [
    ...new Set(
      (Array.isArray(req.body?.programmeCodes) ? req.body.programmeCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const inactivityPeriod = String(req.body?.inactivityPeriod || "14")
    .trim()
    .toLowerCase();

  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!/^(never|\d+)$/.test(inactivityPeriod) || inactivityPeriod === "0") {
    return res.status(400).json({
      error: "inactivityPeriod must be 7, 14, 30, never, or a positive day count"
    });
  }
  if (programmeCodes.length && !assertBatchProgrammeLimit(programmeCodes, res)) {
    return;
  }
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for inactivity report export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCodes,
    inactivityPeriod,
    reportType: "inactivity-report",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] report=inactivity-report category=${categoryName} period=${inactivityPeriod}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: "Building Inactivity Report..."
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message: `Building Inactivity Report... (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_inactivity_report.py",
        "--category-name",
        categoryName,
        "--inactivity-period",
        inactivityPeriod,
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const code of programmeCodes) {
        pythonArgs.push("--programme-code", code);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][inactivity-report]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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
          message: "Inactivity report export failed",
          error: logTail || "Inactivity report export failed",
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

app.post("/api/export-missed-submissions/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const programmeCodes = [
    ...new Set(
      (Array.isArray(req.body?.programmeCodes) ? req.body.programmeCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const moduleCodes = [
    ...new Set(
      (Array.isArray(req.body?.moduleCodes) ? req.body.moduleCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessmentTypes = [
    ...new Set(
      (Array.isArray(req.body?.assessmentTypes) ? req.body.assessmentTypes : [])
        .map((type) => String(type || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessments = [
    ...new Set(
      (Array.isArray(req.body?.assessments) ? req.body.assessments : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    )
  ];
  const dueFrom = String(req.body?.dueFrom || "").trim() || null;
  const dueTo = String(req.body?.dueTo || "").trim() || null;

  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!programmeCodes.length) {
    return res.status(400).json({ error: "At least one programme is required" });
  }
  if (dueFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dueFrom)) {
    return res.status(400).json({ error: "dueFrom must be YYYY-MM-DD" });
  }
  if (dueTo && !/^\d{4}-\d{2}-\d{2}$/.test(dueTo)) {
    return res.status(400).json({ error: "dueTo must be YYYY-MM-DD" });
  }
  if (dueFrom && dueTo && dueFrom > dueTo) {
    return res.status(400).json({ error: "dueFrom must be on or before dueTo" });
  }
  if (!assertBatchProgrammeLimit(programmeCodes, res)) return;
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for missed submission export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCodes,
    moduleCodes,
    assessmentTypes,
    assessments,
    dueFrom,
    dueTo,
    reportType: "missed-submissions",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] report=missed-submissions category=${categoryName}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: "Building Missed Submission Report..."
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message: `Building Missed Submission Report... (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_missed_submissions.py",
        "--category-name",
        categoryName,
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const code of programmeCodes) {
        pythonArgs.push("--programme-code", code);
      }
      for (const code of moduleCodes) {
        pythonArgs.push("--module", code);
      }
      for (const type of assessmentTypes) {
        pythonArgs.push("--assessment-type", type);
      }
      for (const name of assessments) {
        pythonArgs.push("--assessment", name);
      }
      if (dueFrom) {
        pythonArgs.push("--due-from", dueFrom);
      }
      if (dueTo) {
        pythonArgs.push("--due-to", dueTo);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][missed-submissions]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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
          message: "Missed submission export failed",
          error: logTail || "Missed submission export failed",
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

app.post("/api/export-late-submissions/start", async (req, res) => {
  const categoryName = String(req.body?.categoryName || "").trim();
  const programmeCodes = [
    ...new Set(
      (Array.isArray(req.body?.programmeCodes) ? req.body.programmeCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const moduleCodes = [
    ...new Set(
      (Array.isArray(req.body?.moduleCodes) ? req.body.moduleCodes : [])
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessmentTypes = [
    ...new Set(
      (Array.isArray(req.body?.assessmentTypes) ? req.body.assessmentTypes : [])
        .map((type) => String(type || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
  const assessments = [
    ...new Set(
      (Array.isArray(req.body?.assessments) ? req.body.assessments : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    )
  ];
  const dueFrom = String(req.body?.dueFrom || "").trim() || null;
  const dueTo = String(req.body?.dueTo || "").trim() || null;

  if (!categoryName) {
    return res.status(400).json({ error: "categoryName is required" });
  }
  if (!programmeCodes.length) {
    return res.status(400).json({ error: "At least one programme is required" });
  }
  if (dueFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dueFrom)) {
    return res.status(400).json({ error: "dueFrom must be YYYY-MM-DD" });
  }
  if (dueTo && !/^\d{4}-\d{2}-\d{2}$/.test(dueTo)) {
    return res.status(400).json({ error: "dueTo must be YYYY-MM-DD" });
  }
  if (dueFrom && dueTo && dueFrom > dueTo) {
    return res.status(400).json({ error: "dueFrom must be on or before dueTo" });
  }
  if (!assertBatchProgrammeLimit(programmeCodes, res)) return;
  if (!motherduckToken) {
    return res.status(500).json({
      error: "Missing MOTHERDUCK_TOKEN in environment/.env"
    });
  }

  cleanupOldJobs();
  const jobId = makeJobId();
  const startedAt = Date.now();
  registerExportJob(req, {
    jobId,
    status: "queued",
    stage: "queued",
    message: "Queued for late submission export...",
    startedAt,
    updatedAt: startedAt,
    categoryName,
    programmeCodes,
    moduleCodes,
    assessmentTypes,
    assessments,
    dueFrom,
    dueTo,
    reportType: "late-submissions",
    timingsMs: {}
  });

  (async () => {
    try {
      console.info(
        `[export-job:${jobId}] report=late-submissions category=${categoryName}`
      );
      updateJob(jobId, {
        status: "running",
        stage: "excel",
        message: "Building Late Submission Report..."
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        updateJob(jobId, {
          message: `Building Late Submission Report... (${elapsedSec}s)`
        });
      }, 10000);

      const pythonArgs = [
        "populate_late_submissions.py",
        "--category-name",
        categoryName,
        "--warehouse-schema",
        warehouseSchema,
        "--output-dir",
        exportOutputDir
      ];
      for (const code of programmeCodes) {
        pythonArgs.push("--programme-code", code);
      }
      for (const code of moduleCodes) {
        pythonArgs.push("--module", code);
      }
      for (const type of assessmentTypes) {
        pythonArgs.push("--assessment-type", type);
      }
      for (const name of assessments) {
        pythonArgs.push("--assessment", name);
      }
      if (dueFrom) {
        pythonArgs.push("--due-from", dueFrom);
      }
      if (dueTo) {
        pythonArgs.push("--due-to", dueTo);
      }

      let exportResult;
      try {
        exportResult = await runProcess(
          pythonBin,
          pythonArgs,
          projectRoot,
          motherduckEnv(),
          { logPrefix: `[export-job:${jobId}][late-submissions]` }
        );
      } finally {
        clearInterval(heartbeat);
      }

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
          message: "Late submission export failed",
          error: logTail || "Late submission export failed",
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
  res.setHeader("Cache-Control", "no-store");
  res.json(publicJobPayload(job));
});

app.get("/api/audit-log", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 1000);
    const { events, store, durable } = await auditLogger.listEvents({
      limit,
      email: req.query.email,
      reportType: req.query.reportType,
      event: req.query.event,
      appEnv: req.query.appEnv
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      durable,
      store,
      logPath: auditLogger.logPath,
      appEnv,
      appUrl,
      count: events.length,
      events
    });
  } catch (error) {
    console.error("[audit-log]", error);
    res.status(500).json({
      error: `Could not load audit log: ${error?.message || error}`
    });
  }
});

app.get("/api/audit-log/export", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 5000);
    const { events } = await auditLogger.listEvents({
      limit,
      email: req.query.email,
      reportType: req.query.reportType,
      event: req.query.event,
      appEnv: req.query.appEnv
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `GRAB-audit-log-${stamp}.csv`;
    const csv = auditLogger.toCsv(events);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );
    res.send(csv);
  } catch (error) {
    console.error("[audit-log-export]", error);
    res.status(500).json({
      error: `Could not export audit log: ${error?.message || error}`
    });
  }
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
  try {
    await waitForReadableFile(job.filePath);
    const downloader = getRequestUser(req);
    await writeExportAudit("export_downloaded", job, {
      status: "downloaded",
      userEmail: downloader.email,
      userName: downloader.name,
      userRole: downloader.role
    });
    sendExportDownload(res, job);
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

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }

  const normalized = String(req.path || "/").replace(/\/+$/, "") || "/";
  const pageFileByPath = {
    "/": "index.html",
    "/gradebook": "gradebook.html",
    "/gradebook.html": "gradebook.html",
    "/intake-summary": "intake-summary.html",
    "/intake-summary.html": "intake-summary.html",
    "/activity-completion": "activity-completion.html",
    "/activity-completion.html": "activity-completion.html",
    "/inactivity-report": "inactivity-report.html",
    "/inactivity-report.html": "inactivity-report.html",
    "/missed-submission": "missed-submission.html",
    "/missed-submission.html": "missed-submission.html",
    "/late-submission": "late-submission.html",
    "/late-submission.html": "late-submission.html",
    "/audit-log": "audit-log.html",
    "/audit-log.html": "audit-log.html"
  };
  const pageFile = pageFileByPath[normalized] || pageFileByPath[req.path];
  if (pageFile) {
    return res.sendFile(path.join(__dirname, "public", pageFile));
  }

  console.warn(`[nav] unknown path redirected to /: ${req.path}`);
  res.redirect("/");
});

app.listen(port, host, () => {
  console.log(`Gradebook export UI listening on ${host}:${port}`);
  console.log(`Python runtime: ${pythonBin}`);
  if (loadedEnvFiles.length) {
    console.log(`Env file(s): ${loadedEnvFiles.join(", ")}`);
  } else if (motherduckToken) {
    console.log("No .env file found — using environment variables (Render/host).");
  } else {
    console.warn(
      `No .env found and MOTHERDUCK_TOKEN is unset. Create ${path.join(projectRoot, ".env")} or set MOTHERDUCK_TOKEN in the host environment.`
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
  console.log(`Export audit local JSONL: ${auditLogger.logPath}`);
  console.log(`Audit app env: ${appEnv}${appUrl ? ` (${appUrl})` : ""}`);
  if (auditDb.configured) {
    const hostHint = (() => {
      try {
        return new URL(auditDatabaseUrl).hostname;
      } catch {
        return "(unparsed host)";
      }
    })();
    console.log(`Audit Neon URL detected (host: ${hostHint})`);
    void auditDb.ensureReady().then((ok) => {
      if (ok) {
        console.log("Audit durable store: Neon Postgres (table grab_export_audit ready)");
      } else {
        console.warn(
          "Audit durable store: Neon configured but table init failed — using local JSONL until reconnect."
        );
      }
    });
  } else {
    console.warn(
      "Audit durable store: not configured (set NEON_DATABASE_URL or AUDIT_DATABASE_URL on Render, then redeploy). Using ephemeral local JSONL only."
    );
  }
});
