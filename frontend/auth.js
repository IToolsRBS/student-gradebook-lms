import crypto from "crypto";
import express from "express";
import session from "express-session";
import * as msal from "@azure/msal-node";

const SCOPES = ["openid", "profile", "email", "User.Read"];

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

  if (!enabledFlag) {
    return { enabled: false };
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
    authPrompt
  };
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

export function createRequireAuth(config) {
  return function requireAuth(req, res, next) {
    if (!config?.enabled) return next();
    if (isPublicPath(req.path)) return next();
    if (req.session?.account) return next();

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

function accountAllowed(account, allowedDomain) {
  if (!allowedDomain) return true;
  const email = String(account?.username || account?.idTokenClaims?.preferred_username || "")
    .trim()
    .toLowerCase();
  return email.endsWith(`@${allowedDomain}`);
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

      if (!accountAllowed(tokenResponse.account, config.allowedDomain)) {
        req.session.destroy(() => {});
        return res
          .status(403)
          .send("Your account is not allowed to access this application.");
      }

      req.session.account = {
        name: tokenResponse.account.name || "",
        email:
          tokenResponse.account.username ||
          tokenResponse.idTokenClaims?.preferred_username ||
          "",
        oid: tokenResponse.account.localAccountId || ""
      };
      delete req.session.auth;

      res.redirect(authRequest.returnTo || "/");
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
    res.json({
      authenticated: true,
      user: req.session.account
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
