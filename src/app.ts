import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { getRequestContext } from "./lib/requestContext.js";
import apiRoutes from "./routes/index.js";
import { requestContext } from "./middlewares/requestContext.js";
import { notFoundHandler } from "./middlewares/notFound.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { asyncHandler } from "./utils/asyncHandler.js";
import { sendSuccess } from "./utils/apiResponse.js";

const app = express();

// Needed behind a reverse proxy / load balancer (Render, Railway, Cloud Run…)
// so req.ip and secure cookies work.
app.set("trust proxy", 1);

// ---- Request ID, IP and user agent for this request: must stay FIRST ----
app.use(requestContext);

// ---- Request logging (one line per request) ----
// Before body parsing, so requests with broken JSON are logged too.
app.use(
  pinoHttp({
    logger,
    // Use our request ID instead of pino's 1, 2, 3 counter.
    genReqId: () => getRequestContext()?.requestId ?? "unknown",
    autoLogging: { ignore: (req) => req.url === "/health" },
  })
);

// ---- Security ----
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    // Let the web console read a download's file name and row count (CSV reports, DEC-299).
    exposedHeaders: ["Content-Disposition", "X-Row-Count"],
  })
);

// ---- Body parsing ----
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// Reads cookies into req.cookies (the web console's refresh token).
app.use(cookieParser());

// ---- Health check: confirms the server AND the database are up ----
app.get(
  "/health",
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    sendSuccess(res, 200, { status: "ok", database: "up", uptime: process.uptime() });
  })
);

// ---- API routes ----
app.use("/api", apiRoutes);

// ---- 404, then the error handler: these two must stay LAST, in this order ----
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
