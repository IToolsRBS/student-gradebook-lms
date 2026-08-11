import crypto from "crypto";
import express from "express";
import session from "express-session";
import * as msal from "@azure/msal-node";

const SCOPES = ["openid", "profile", "email", "User.Read"];

/** Default: full access to every report. */
export const ROLE_FULL = "full";
/** Restricted: Full Gradebook Export + Intake Summary only. */
export const ROLE_GRADEBOOK = "gradebook";
/** Admin: all reports + export audit log. */
export const ROLE_ADMIN = "admin";

export const ALL_FEATURES = [
  "all-reports",
  "gradebook",
  "intake-summary",
  "activity-completion",
  "inactivity-report",
  "missed-submission",
  "late-submission",
  "audit-log"
];

const ROLE_DEFINITIONS = {
  [ROLE_ADMIN]: {
    features: ALL_FEATURES,
    homePath: "/"
  },
  [ROLE_FULL]: {
    features: ALL_FEATURES.filter((feature) => feature !== "audit-log"),
    homePath: "/"
  },
  [ROLE_GRADEBOOK]: {
    features: ["all-reports", "gradebook", "intake-summary"],
    homePath: "/"
  }
};

/** Page path → feature key (used for UI + page gating). */
export const PATH_FEATURES = {
  "/": "all-reports",
  "/gradebook": "gradebook",
  "/gradebook.html": "gradebook",
  "/intake-summary": "intake-summary",
  "/intake-summary.html": "intake-summary",
  "/activity-completion": "activity-completion",
  "/activity-completion.html": "activity-completion",
  "/inactivity-report": "inactivity-report",
  "/inactivity-report.html": "inactivity-report",
  "/missed-submission": "missed-submission",
  "/missed-submission.html": "missed-submission",
  "/late-submission": "late-submission",
  "/late-submission.html": "late-submission",
  "/audit-log": "audit-log",
  "/audit-log.html": "audit-log"
};

/** API path prefix → required feature (shared metadata APIs stay open to any signed-in role). */
export const API_FEATURES = {
  "/api/export-excel/start": "gradebook",
  "/api/export-intake-summary/start": "intake-summary",
  "/api/export-activity-completion/start": "activity-completion",
  "/api/export-inactivity-report/start": "inactivity-report",
  "/api/export-missed-submissions/start": "missed-submission",
  "/api/export-late-submissions/start": "late-submission",
  "/api/audit-log": "audit-log",
  "/api/audit-log/export": "audit-log"
};

function isTruthy(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function resolveAuthConfig(readEnvValue) {
  const clientId = readEnvValue(["AZURE_CLIENT_ID"]);
  const clientSecret = readEnvValue(["AZURE_CLIENT_SECRET"]);
  const tenantId = readEnvValue(["AZURE_TENANT_ID"]);
  const sessionSecret = readEnvValue(["SESSION_SECRET"]);
  const explicitEnabled = readEnvValue(["AZURE_AUTH_ENABLED"]);
  const enabledFlag =
    explicitEnabled !== null && explicitEnabled !== undefined
      ? isTruthy(explicitEnabled)
      : process.env.NODE_ENV === "production" || Boolean(clientId);

  const gradebookOnlyEmails = parseAllowedEmails(
    readEnvValue(["APP_ROLE_GRADEBOOK_ONLY_EMAILS"])
  );
  const adminEmails = parseAllowedEmails(
    readEnvValue(["APP_ROLE_ADMIN_EMAILS"])
  );

  if (!enabledFlag) {
    return {
      enabled: false,
      gradebookOnlyEmails,
      adminEmails
    };
  }

  const missing = [];
  if (!clientId) missing.push("AZURE_CLIENT_ID");
  if (!clientSecret) missing.push("AZURE_CLIENT_SECRET");
  if (!tenantId) missing.push("AZURE_TENANT_ID");
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (missing.length) {
    throw new Error(
      `Microsoft sign-in is enabled but missing: ${missing.join(", ")}`
    );
  }

  const baseUrl = resolveBaseUrl(readEnvValue);
  const allowedDomain = (
    readEnvValue(["AZURE_ALLOWED_DOMAIN"]) || ""
  ).toLowerCase();
  const allowedEmails = parseAllowedEmails(
    readEnvValue(["AZURE_ALLOWED_EMAILS"])
  );
  const authPrompt = readEnvValue(["AZURE_AUTH_PROMPT"]) || "select_account";

  return {
    enabled: true,
    clientId,
    clientSecret,
    tenantId,
    sessionSecret,
    baseUrl,
    redirectUri: `${baseUrl}/auth/callback`,
    postLogoutRedirectUri: baseUrl,
    allowedDomain,
    allowedEmails,
    authPrompt,
    gradebookOnlyEmails,
    adminEmails
  };
}

export function resolveUserRole(email, config) {
  const normalized = String(email || "").trim().toLowerCase();
  if (
    normalized &&
    config?.adminEmails instanceof Set &&
    config.adminEmails.has(normalized)
  ) {
    return ROLE_ADMIN;
  }
  if (
    normalized &&
    config?.gradebookOnlyEmails instanceof Set &&
    config.gradebookOnlyEmails.has(normalized)
  ) {
    return ROLE_GRADEBOOK;
  }
  return ROLE_FULL;
}

export function getRoleDefinition(role) {
  return ROLE_DEFINITIONS[role] || ROLE_DEFINITIONS[ROLE_FULL];
}

export function getAccessForEmail(email, config) {
  const role = resolveUserRole(email, config);
  const definition = getRoleDefinition(role);
  return {
    role,
    features: definition.features,
    homePath: definition.homePath
  };
}

export function userHasFeature(email, feature, config) {
  if (!config?.enabled) return true;
  const { features } = getAccessForEmail(email, config);
  return features.includes(feature);
}

export function resolveBaseUrl(readEnvValue) {
  const raw =
    readEnvValue(["BASE_URL", "APP_URL", "RENDER_EXTERNAL_URL"]) || "";
  const baseUrl = String(raw).trim().replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error(
      "BASE_URL (or RENDER_EXTERNAL_URL on Render) is required for Microsoft sign-in"
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`BASE_URL must start with http:// or https:// (got ${baseUrl})`);
  }
  return baseUrl;
}

function createMsalClient(config) {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret
    }
  });
}

export function createSessionMiddleware(config) {
  const secureCookie =
    isTruthy(process.env.SESSION_COOKIE_SECURE) ||
    process.env.NODE_ENV === "production";
  return session({
    name: "gradebook.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "lax",
      maxAge: Number(process.env.SESSION_MAX_AGE_MS || 1000 * 60 * 60 * 8)
    }
  });
}

function isPublicPath(pathname) {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/auth/") ||
    pathname === "/favicon.ico"
  );
}

function denyAccess(req, res, message) {
  if (req.path.startsWith("/api/")) {
    return res.status(403).json({ error: message });
  }
  return res.status(403).send(message);
}

function featureForRequest(req) {
  const pathname = String(req.path || "").replace(/\/$/, "") || "/";
  if (API_FEATURES[pathname]) return API_FEATURES[pathname];
  if (PATH_FEATURES[pathname]) return PATH_FEATURES[pathname];
  if (PATH_FEATURES[req.path]) return PATH_FEATURES[req.path];
  return null;
}

export function createRequireAuth(config) {
  return function requireAuth(req, res, next) {
    if (!config?.enabled) return next();
    if (isPublicPath(req.path)) return next();

    if (req.session?.account) {
      if (!emailAllowed(req.session.account.email, config)) {
        req.session.destroy(() => {});
        return denyAccess(
          req,
          res,
          "Your account is not allowed to access this application."
        );
      }

      const access = getAccessForEmail(req.session.account.email, config);
      req.access = access;
      req.session.account.role = access.role;

      const feature = featureForRequest(req);
      if (feature && !access.features.includes(feature)) {
        if (req.path.startsWith("/api/")) {
          return res.status(403).json({
            error: "Your account is not allowed to use this report."
          });
        }
        return res.redirect(access.homePath || "/gradebook");
      }

      return next();
    }

    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Sign in required",
        loginUrl: "/auth/login"
      });
    }

    const returnTo = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(`/auth/login?returnTo=${returnTo}`);
  };
}

function parseAllowedEmails(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(/[,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function accountEmail(account) {
  return String(
    account?.email ||
      account?.username ||
      account?.idTokenClaims?.preferred_username ||
      ""
  )
    .trim()
    .toLowerCase();
}

function emailAllowed(email, config) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;

  if (config.allowedEmails.size > 0) {
    return config.allowedEmails.has(normalized);
  }

  if (config.allowedDomain) {
    return normalized.endsWith(`@${config.allowedDomain}`);
  }

  return true;
}

export function createAuthRouter(config) {
  const router = express.Router();
  const msalClient = createMsalClient(config);
  const cryptoProvider = new msal.CryptoProvider();

  router.get("/login", async (req, res) => {
    try {
      const state = cryptoProvider.base64Encode(
        crypto.randomBytes(16).toString("hex")
      );
      const nonce = cryptoProvider.base64Encode(
        crypto.randomBytes(16).toString("hex")
      );
      const returnTo = sanitizeReturnTo(req.query.returnTo);
      req.session.auth = { state, nonce, returnTo };

      const authCodeUrl = await msalClient.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: config.redirectUri,
        state,
        nonce,
        prompt: config.authPrompt
      });
      res.redirect(authCodeUrl);
    } catch (error) {
      console.error("[auth/login]", error);
      res.status(500).send("Could not start Microsoft sign-in.");
    }
  });

  router.get("/callback", async (req, res) => {
    try {
      const authRequest = req.session.auth;
      if (!authRequest) {
        return res.redirect("/auth/login");
      }

      if (req.query.state !== authRequest.state) {
        return res.status(400).send("Invalid sign-in state. Please try again.");
      }

      const tokenResponse = await msalClient.acquireTokenByCode({
        code: String(req.query.code || ""),
        scopes: SCOPES,
        redirectUri: config.redirectUri,
        nonce: authRequest.nonce
      });

      if (!tokenResponse?.account) {
        return res.status(401).send("Microsoft sign-in did not return an account.");
      }

      if (!emailAllowed(accountEmail(tokenResponse.account), config)) {
        req.session.destroy(() => {});
        return res
          .status(403)
          .send("Your account is not allowed to access this application.");
      }

      const email = accountEmail(tokenResponse.account);
      const access = getAccessForEmail(email, config);
      req.session.account = {
        name: tokenResponse.account.name || "",
        email,
        oid: tokenResponse.account.localAccountId || "",
        role: access.role
      };
      delete req.session.auth;

      const returnTo = authRequest.returnTo || "/";
      const returnFeature = PATH_FEATURES[returnTo.replace(/\/$/, "") || "/"];
      if (returnFeature && !access.features.includes(returnFeature)) {
        return res.redirect(access.homePath);
      }
      res.redirect(returnTo === "/" ? access.homePath : returnTo);
    } catch (error) {
      console.error("[auth/callback]", error);
      res.status(500).send("Microsoft sign-in failed. Please try again.");
    }
  });

  router.get("/logout", (req, res) => {
    req.session.destroy(() => {
      const logoutUrl = new URL(
        `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/logout`
      );
      logoutUrl.searchParams.set(
        "post_logout_redirect_uri",
        config.postLogoutRedirectUri
      );
      res.redirect(logoutUrl.toString());
    });
  });

  router.get("/me", (req, res) => {
    if (!req.session?.account) {
      return res.status(401).json({ authenticated: false });
    }
    const access = getAccessForEmail(req.session.account.email, config);
    res.json({
      authenticated: true,
      user: {
        ...req.session.account,
        role: access.role
      },
      role: access.role,
      features: access.features,
      homePath: access.homePath
    });
  });

  return router;
}

function sanitizeReturnTo(value) {
  const raw = String(value || "/").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }
  return raw;
}
